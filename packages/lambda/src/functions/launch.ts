import {InvokeCommand} from '@aws-sdk/client-lambda';
import fs from 'fs';
import {Internals} from 'remotion';
import {validateFramesPerLambda} from '../api/validate-frames-per-lambda';
import {getLambdaClient} from '../shared/aws-clients';
import {chunk} from '../shared/chunk';
import {
	CURRENT_VERSION,
	EncodingProgress,
	encodingProgressKey,
	LambdaPayload,
	LambdaRoutines,
	outName,
	RenderMetadata,
	renderMetadataKey,
	rendersPrefix,
} from '../shared/constants';
import {getServeUrlHash} from '../shared/make-s3-url';
import {validatePrivacy} from '../shared/validate-privacy';
import {collectChunkInformation} from './chunk-optimization/collect-data';
import {getFrameRangesFromProfile} from './chunk-optimization/get-frame-ranges-from-profile';
import {getProfileDuration} from './chunk-optimization/get-profile-duration';
import {isValidOptimizationProfile} from './chunk-optimization/is-valid-profile';
import {optimizeInvocationOrder} from './chunk-optimization/optimize-invocation-order';
import {optimizeProfileRecursively} from './chunk-optimization/optimize-profile';
import {planFrameRanges} from './chunk-optimization/plan-frame-ranges';
import {
	getOptimization,
	writeOptimization,
} from './chunk-optimization/s3-optimization-file';
import {concatVideosS3} from './helpers/concat-videos';
import {createPostRenderData} from './helpers/create-post-render-data';
import {cleanupFiles} from './helpers/delete-chunks';
import {getBrowserInstance} from './helpers/get-browser-instance';
import {getCurrentRegionInFunction} from './helpers/get-current-region';
import {getFilesToDelete} from './helpers/get-files-to-delete';
import {getLambdasInvokedStats} from './helpers/get-lambdas-invoked-stats';
import {inspectErrors} from './helpers/inspect-errors';
import {lambdaLs, lambdaWriteFile} from './helpers/io';
import {timer} from './helpers/timer';
import {validateComposition} from './helpers/validate-composition';
import {
	getTmpDirStateIfENoSp,
	writeLambdaError,
} from './helpers/write-lambda-error';
import {writePostRenderData} from './helpers/write-post-render-data';

type Options = {
	expectedBucketOwner: string;
};

const innerLaunchHandler = async (params: LambdaPayload, options: Options) => {
	if (params.type !== LambdaRoutines.launch) {
		throw new Error('Expected launch type');
	}

	if (!params.framesPerLambda) {
		throw new Error('You need to pass "framesPerLambda" parameter');
	}

	validateFramesPerLambda(params.framesPerLambda);

	const [browserInstance, optimization] = await Promise.all([
		getBrowserInstance(params.saveBrowserLogs),
		getOptimization({
			bucketName: params.bucketName,
			siteId: getServeUrlHash(params.serveUrl),
			compositionId: params.composition,
			region: getCurrentRegionInFunction(),
			expectedBucketOwner: options.expectedBucketOwner,
		}),
	]);

	const comp = await validateComposition({
		serveUrl: params.serveUrl,
		composition: params.composition,
		browserInstance,
		inputProps: params.inputProps,
	});
	Internals.validateDurationInFrames(
		comp.durationInFrames,
		'passed to <Component />'
	);
	Internals.validateFps(comp.fps, 'passed to <Component />');
	Internals.validateDimension(comp.height, 'height', 'passed to <Component />');
	Internals.validateDimension(comp.width, 'width', 'passed to <Component />');
	validatePrivacy(params.privacy);

	const {framesPerLambda} = params;
	const chunkCount = Math.ceil(comp.durationInFrames / framesPerLambda);

	const {chunks, didUseOptimization} = planFrameRanges({
		chunkCount,
		framesPerLambda,
		frameCount: comp.durationInFrames,
		optimization,
		shouldUseOptimization: params.enableChunkOptimization,
	});
	const sortedChunks = chunks.slice().sort((a, b) => a[0] - b[0]);
	const invokers = Math.round(Math.sqrt(chunks.length));

	const reqSend = timer('sending off requests');
	const lambdaPayloads = chunks.map((chunkPayload) => {
		const payload: LambdaPayload = {
			type: LambdaRoutines.renderer,
			frameRange: chunkPayload,
			serveUrl: params.serveUrl,
			chunk: sortedChunks.indexOf(chunkPayload),
			composition: params.composition,
			fps: comp.fps,
			height: comp.height,
			width: comp.width,
			durationInFrames: comp.durationInFrames,
			bucketName: params.bucketName,
			retriesLeft: params.maxRetries,
			inputProps: params.inputProps,
			renderId: params.renderId,
			imageFormat: params.imageFormat,
			codec: params.codec,
			crf: params.crf,
			envVariables: params.envVariables,
			pixelFormat: params.pixelFormat,
			proResProfile: params.proResProfile,
			quality: params.quality,
			privacy: params.privacy,
			saveBrowserLogs: params.saveBrowserLogs,
			attempt: 1,
		};
		return payload;
	});
	const renderMetadata: RenderMetadata = {
		startedDate: Date.now(),
		videoConfig: comp,
		totalChunks: chunks.length,
		estimatedTotalLambdaInvokations: [
			// Direct invokations
			chunks.length,
			// Parent invokers
			invokers,
			// This function
		].reduce((a, b) => a + b, 0),
		estimatedRenderLambdaInvokations: chunks.length,
		compositionId: comp.id,
		siteId: getServeUrlHash(params.serveUrl),
		codec: params.codec,
		usesOptimizationProfile: didUseOptimization,
		type: 'video',
		imageFormat: params.imageFormat,
		inputProps: params.inputProps,
		lambdaVersion: CURRENT_VERSION,
		framesPerLambda: params.framesPerLambda,
		memorySizeInMb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE),
		region: getCurrentRegionInFunction(),
		renderId: params.renderId,
	};

	await lambdaWriteFile({
		bucketName: params.bucketName,
		key: renderMetadataKey(params.renderId),
		body: JSON.stringify(renderMetadata),
		region: getCurrentRegionInFunction(),
		privacy: 'private',
		expectedBucketOwner: options.expectedBucketOwner,
	});

	const payloadChunks = chunk(lambdaPayloads, invokers);
	await Promise.all(
		payloadChunks.map(async (payloads, index) => {
			const callingLambdaTimer = timer('Calling chunk ' + index);
			const firePayload: LambdaPayload = {
				type: LambdaRoutines.fire,
				payloads,
				renderId: params.renderId,
			};
			await getLambdaClient(getCurrentRegionInFunction()).send(
				new InvokeCommand({
					FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
					// @ts-expect-error
					Payload: JSON.stringify(firePayload),
					InvocationType: 'Event',
				}),
				{}
			);
			callingLambdaTimer.end();
		})
	);
	reqSend.end();

	let lastProgressUploaded = 0;
	let encodingStop: number | null = null;

	const onProgress = (framesEncoded: number, start: number) => {
		const relativeProgress = framesEncoded / comp.durationInFrames;
		const deltaSinceLastProgressUploaded =
			relativeProgress - lastProgressUploaded;
		if (relativeProgress === 1) {
			encodingStop = Date.now();
		}

		if (deltaSinceLastProgressUploaded < 0.1) {
			return;
		}

		lastProgressUploaded = relativeProgress;

		const encodingProgress: EncodingProgress = {
			framesEncoded,
			totalFrames: comp.durationInFrames,
			doneIn: encodingStop ? encodingStop - start : null,
			timeToInvoke: null,
		};
		lambdaWriteFile({
			bucketName: params.bucketName,
			key: encodingProgressKey(params.renderId),
			body: JSON.stringify(encodingProgress),
			region: getCurrentRegionInFunction(),
			privacy: 'private',
			expectedBucketOwner: options.expectedBucketOwner,
		}).catch((err) => {
			writeLambdaError({
				bucketName: params.bucketName,
				errorInfo: {
					chunk: null,
					frame: null,
					isFatal: false,
					stack: `Could not upload stitching progress ${
						(err as Error).stack as string
					}`,
					tmpDir: null,
					type: 'stitcher',
					attempt: 1,
					totalAttempts: 1,
					willRetry: false,
				},
				renderId: params.renderId,
				expectedBucketOwner: options.expectedBucketOwner,
			});
		});
	};

	const {outfile, cleanupChunksProm, encodingStart} = await concatVideosS3({
		bucket: params.bucketName,
		expectedFiles: chunkCount,
		onProgress,
		numberOfFrames: comp.durationInFrames,
		renderId: params.renderId,
		region: getCurrentRegionInFunction(),
		codec: params.codec,
		expectedBucketOwner: options.expectedBucketOwner,
	});
	if (!encodingStop) {
		encodingStop = Date.now();
	}

	await lambdaWriteFile({
		bucketName: params.bucketName,
		key: outName(params.renderId, params.codec),
		body: fs.createReadStream(outfile),
		region: getCurrentRegionInFunction(),
		privacy: params.privacy,
		expectedBucketOwner: options.expectedBucketOwner,
	});

	let chunkProm: Promise<unknown> = Promise.resolve();

	if (params.enableChunkOptimization) {
		const chunkData = await collectChunkInformation({
			bucketName: params.bucketName,
			renderId: params.renderId,
			region: getCurrentRegionInFunction(),
			expectedBucketOwner: options.expectedBucketOwner,
		});
		const optimizedProfile = optimizeInvocationOrder(
			optimizeProfileRecursively(chunkData, 400)
		);
		const optimizedFrameRange = getFrameRangesFromProfile(optimizedProfile);
		chunkProm = isValidOptimizationProfile(optimizedProfile)
			? writeOptimization({
					bucketName: params.bucketName,
					optimization: {
						frameRange: optimizedFrameRange,
						oldTiming: getProfileDuration(chunkData),
						newTiming: getProfileDuration(optimizedProfile),
						frameCount: comp.durationInFrames,
						createdFromRenderId: params.renderId,
						framesPerLambda,
						lambdaVersion: CURRENT_VERSION,
					},
					expectedBucketOwner: options.expectedBucketOwner,
					compositionId: params.composition,
					siteId: getServeUrlHash(params.serveUrl),
					region: getCurrentRegionInFunction(),
			  })
			: Promise.resolve();
	}

	const [, contents] = await Promise.all([
		chunkProm,
		lambdaLs({
			bucketName: params.bucketName,
			prefix: rendersPrefix(params.renderId),
			expectedBucketOwner: options.expectedBucketOwner,
			region: getCurrentRegionInFunction(),
		}),
	]);
	const finalEncodingProgress: EncodingProgress = {
		framesEncoded: comp.durationInFrames,
		totalFrames: comp.durationInFrames,
		doneIn: encodingStop ? encodingStop - encodingStart : null,
		timeToInvoke: getLambdasInvokedStats(
			contents,
			params.renderId,
			renderMetadata.estimatedRenderLambdaInvokations,
			renderMetadata.startedDate
		).timeToInvokeLambdas,
	};
	const finalEncodingProgressProm = lambdaWriteFile({
		bucketName: params.bucketName,
		key: encodingProgressKey(params.renderId),
		body: JSON.stringify(finalEncodingProgress),
		region: getCurrentRegionInFunction(),
		privacy: 'private',
		expectedBucketOwner: options.expectedBucketOwner,
	});

	const errorExplanationsProm = inspectErrors({
		contents,
		renderId: params.renderId,
		bucket: params.bucketName,
		region: getCurrentRegionInFunction(),
		expectedBucketOwner: options.expectedBucketOwner,
	});

	const jobs = getFilesToDelete({
		chunkCount,
		renderId: params.renderId,
	});

	const deletProm = cleanupFiles({
		region: getCurrentRegionInFunction(),
		bucket: params.bucketName,
		contents,
		jobs,
	});

	const postRenderData = createPostRenderData({
		bucketName: params.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		region: getCurrentRegionInFunction(),
		renderId: params.renderId,
		memorySizeInMb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE),
		renderMetadata,
		contents,
		errorExplanations: await errorExplanationsProm,
		timeToEncode: encodingStop - encodingStart,
		timeToDelete: await deletProm,
	});
	await finalEncodingProgressProm;
	await writePostRenderData({
		bucketName: params.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		postRenderData,
		region: getCurrentRegionInFunction(),
		renderId: params.renderId,
	});

	await Promise.all([cleanupChunksProm, fs.promises.rm(outfile)]);
};

export const launchHandler = async (
	params: LambdaPayload,
	options: Options
) => {
	if (params.type !== LambdaRoutines.launch) {
		throw new Error('Expected launch type');
	}

	try {
		await innerLaunchHandler(params, options);
	} catch (err) {
		console.log('Error occurred', err);
		await writeLambdaError({
			bucketName: params.bucketName,
			errorInfo: {
				chunk: null,
				frame: null,
				stack: (err as Error).stack as string,
				type: 'stitcher',
				isFatal: true,
				tmpDir: getTmpDirStateIfENoSp((err as Error).stack as string),
				attempt: 1,
				totalAttempts: 1,
				willRetry: false,
			},
			expectedBucketOwner: options.expectedBucketOwner,
			renderId: params.renderId,
		});
	}
};
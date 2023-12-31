import type { RequestHandler } from './$types';
import { error as svelteError, json } from '@sveltejs/kit';
import { getSupabase } from '@supabase/auth-helpers-sveltekit';
import { supabaseClientAdmin } from '$lib/db.server';
import { getAdminUserInfo, handleError, type UserInfo } from '$lib/db';
import { getNegativePrompt, getReplacedPrompt } from '$lib/prompts.server';
import { getPredictionStatus, runPrediction } from '$lib/replicate.server';
import { getPrompt } from '$lib/themes';
import type { PostgrestResponse } from '@supabase/supabase-js';
import { getLimitedQuantity } from '$lib/predictions.server';
import Replicate from 'replicate';

interface GeneratePayload {
	theme: string | undefined;
	prompt: string | undefined;
	seed: string | undefined;
	quantity: number | string | undefined;
}

export const GET: RequestHandler = async (event) => {
	try {
		const predictionID = event.url.searchParams.get('id');
		const { session } = await getSupabase(event);

		if (!predictionID) {
			throw new Error('Prediction ID not valid');
		}
		if (!session) {
			throw new Error('Session not valid');
		}

		const userInfo = await getAdminUserInfo(session.user.id, supabaseClientAdmin);

		if (!userInfo.paid) {
			throw new Error('Payment required');
		}

		if (userInfo.in_training || !userInfo.trained || !userInfo.replicate_version_id) {
			throw new Error('Model not trained');
		}

		if (userInfo.counter >= 100) {
			throw new Error('You cannot generate more than 100 photos');
		}

		const predictionResponse = await getPredictionStatus(predictionID);
		console.log('Predict response', predictionResponse);

		const { error } = await supabaseClientAdmin.from('predictions').upsert({
			id: predictionResponse.id,
			user_id: session.user.id,
			status: predictionResponse.status
		});
		if (error) {
			throw new Error('Error on insert prediction', { cause: error });
		}
		const [url] = predictionResponse.output || [];
		if (url) {
			const REPLICATE_API_TOKEN = 'r8_E3q5NczWE666LSoVA5Pf8HgfBuiijWU4Nlyf2';

			const replicate = new Replicate({
				auth: process.env.REPLICATE_API_TOKEN || REPLICATE_API_TOKEN
			});

			const output = await replicate.run(
				'tencentarc/gfpgan:9283608cc6b7be6b65a8e44983db012355fde4132009bf99d976b2f0896856a3',
				{
					input: {
						img: url // Use the extracted URL as the input image URL
					}
				}
			);
			const image = await fetch(url);
			await handleError(
				await supabaseClientAdmin.storage
					.from('photos-generated')
					.upload(`${session.user.id}/${predictionResponse.id}.jpg`, await image.arrayBuffer())
			);
		} else {
			throw new Error('Missing url', {
				cause: predictionResponse
			});
		}

		return json({ done: true });
	} catch (error) {
		console.error(error);
		if (error instanceof Error) {
			console.error(error.cause);
			throw svelteError(500, { message: error.message });
		}
		throw svelteError(500);
	}
};

export const _generatePhotos = async (payload: GeneratePayload, userInfo: UserInfo) => {
	let { theme, quantity, prompt, seed } = payload;
	if (theme) {
		prompt = getPrompt(theme);
	}
	if (!prompt) {
		throw new Error('Theme not selected');
	}

	if (!userInfo.paid) {
		throw new Error('Payment required');
	}

	if (userInfo.in_training || !userInfo.trained || !userInfo.replicate_version_id) {
		throw new Error('Model not trained');
	}

	const negativePrompt = getNegativePrompt();
	console.log({ prompt, negativePrompt, seed });

	if (typeof quantity == 'string') {
		quantity = parseInt(quantity);
		if (isNaN(quantity)) {
			throw new Error('Wrong quantity');
		}
	}
	quantity = getLimitedQuantity(quantity || 1);
	const quantityLimit = 100;
	if (quantity > quantityLimit - userInfo.counter) {
		if (quantityLimit - userInfo.counter > 0) {
			quantity = quantityLimit - userInfo.counter;
		} else {
			throw new Error('You have already generated 100 photos');
		}
	}

	const promises: Promise<PostgrestResponse<undefined>>[] = [];
	for (let i = 0; i < quantity; i++) {
		promises.push(
			runPrediction(
				userInfo.replicate_version_id,
				getReplacedPrompt(prompt, userInfo.instance_class),
				negativePrompt,
				seed,
				userInfo.id
			).then((predictionResponse) => {
				console.log('Predict response', predictionResponse);
				return supabaseClientAdmin.from('predictions').insert({
					id: predictionResponse.id,
					user_id: userInfo.id,
					status: predictionResponse.status
				});
			})
		);
	}

	await Promise.all(promises)
		.then((responses) => {
			for (let i = 0; i < responses.length; i++) {
				if (responses[i].error) {
					throw new Error('Error on insert prediction', {
						cause: responses[i].error
					});
				}
			}
		})
		.catch((err) => {
			throw new Error('Error on insert prediction', { cause: err });
		});

	handleError(
		await supabaseClientAdmin
			.from('user_info')
			.update({
				counter: userInfo.counter + quantity
			})
			.eq('id', userInfo.id)
	);
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = (await event.request.json()) as GeneratePayload;
		const { theme, seed } = body;
		let { prompt, quantity = 1 } = body;

		const { session } = await getSupabase(event);

		if (!session) {
			throw new Error('Session not valid');
		}

		const user = session.user;
		console.log('user', user);

		const userInfo = await getAdminUserInfo(session.user.id, supabaseClientAdmin);

		await _generatePhotos(
			{
				theme,
				seed,
				prompt,
				quantity
			},
			userInfo
		);

		return json({ done: true });
	} catch (error) {
		console.error(error);
		if (error instanceof Error) {
			console.error(error.cause);
			throw svelteError(500, { message: error.message });
		}
		throw svelteError(500);
	}
};

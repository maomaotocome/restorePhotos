import { Ratelimit } from '@upstash/ratelimit';
import type { NextApiRequest, NextApiResponse } from 'next';
import redis from '../../utils/redis';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';


type Data = string;
interface ExtendedNextApiRequest extends NextApiRequest {
  body: {
    imageUrl: string;
  };
}

// Create a new ratelimiter, that allows 2 requests per day
const ratelimit = redis
  ? new Ratelimit({
    redis: redis,
    limiter: Ratelimit.fixedWindow(2, '1440 m'),
    analytics: true,
  })
  : undefined;

export default async function handler(
  req: ExtendedNextApiRequest,
  res: NextApiResponse<Data>
) {
  // Check if user is logged in
  const session = await getServerSession(req, res, authOptions);
  if (!session || !session.user) {
    return res.status(500).json('Login to upload.');
  }

  // Rate Limiting by user email
  if (ratelimit) {
    const identifier = session.user.email;
    const result = await ratelimit.limit(identifier!);
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);

    // Calcualte the remaining time until generations are reset
    const diff = Math.abs(
      new Date(result.reset).getTime() - new Date().getTime()
    );
    const hours = Math.floor(diff / 1000 / 60 / 60);
    const minutes = Math.floor(diff / 1000 / 60) - hours * 60;

    if (!result.success) {
      return res
        .status(429)
        .json(
          `Your generations will renew in ${hours} hours and ${minutes} minutes. Email hassan@hey.com if you have any questions.`
        );
    }
  }


  const imageUrl = req.body.imageUrl;
  // POST request to Replicate to start the image restoration generation process
  let startResponse = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Token ' + process.env.REPLICATE_API_KEY,
    },
    body: JSON.stringify({
      version: 'a07f252abbbd832009640b27f063ea52d87d7a23a185ca165bec23b5adc8deaf',
      input: {
        image: imageUrl,
        style: "Clay",
        prompt: "a person in a post apocalyptic war game",
        instant_id_strength: 0.8
      },
    }),
  });
  let requestBody = {
    version: 'a07f252abbbd832009640b27f063ea52d87d7a23a185ca165bec23b5adc8deaf',
    input: {
      image: imageUrl, // 从请求体中获取的图像URL
      style: "Clay",
      prompt: "a person in a post apocalyptic war game",
      lora_scale: 0.5,
      custom_lora_url: "https://replicate.delivery/pbxt/[id]/trained_model.tar",
      negative_prompt: "no ruins",
      prompt_strength: 0.8,
      denoising_strength: 0.1,
      instant_id_strength: 0.8,
      control_depth_strength: 0.3
    }
  };


  let jsonStartResponse = await startResponse.json();
  if (jsonStartResponse.status === 'succeeded') {
    let outputUrls = jsonStartResponse.output; // 假设输出是一个包含URI的数组
    console.log("Generated Images:", outputUrls);
    res.status(200).json(outputUrls);
  } else if (jsonStartResponse.status === 'failed') {
    console.log('Failed to generate images:', jsonStartResponse.error);
    res.status(500).json('Failed to restore image');
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 如果状态不是成功也不是失败，可能还在处理中
  }

  let endpointUrl = jsonStartResponse.urls.get;

  // GET request to get the status of the image restoration process & return the result when it's ready
  let restoredImage: string | null = null;
  while (!restoredImage) {
    // Loop in 1s intervals until the alt text is ready
    console.log('polling for result...');
    let finalResponse = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Token ' + process.env.REPLICATE_API_KEY,
      },
    });
    let jsonFinalResponse = await finalResponse.json();

    if (jsonFinalResponse.status === 'succeeded') {
      restoredImage = jsonFinalResponse.output;
    } else if (jsonFinalResponse.status === 'failed') {
      break;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  res
    .status(200)
    .json(restoredImage ? restoredImage : 'Failed to restore image');
}

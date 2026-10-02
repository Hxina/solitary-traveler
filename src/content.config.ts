import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const contentRoot = process.env.SOLITARY_CONTENT_ROOT || './src/content';

const notes = defineCollection({
  loader: glob({
    base: pathToFileURL(resolve(contentRoot, 'notes')),
    pattern: '**/*.{md,mdx}',
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string(),
    type: z.literal('note'),
    cover: z.string().optional(),
    place: z.string().optional(),
  }),
});

const places = defineCollection({
  loader: glob({
    base: pathToFileURL(resolve(contentRoot, 'places')),
    pattern: '**/*.{md,mdx}',
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string(),
    type: z.literal('place'),
    cover: z.string().optional(),
    season: z.string().optional(),
  }),
});

export const collections = { notes, places };

import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const notes = defineCollection({
  loader: glob({ base: './src/content/notes', pattern: '**/*.{md,mdx}' }),
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
  loader: glob({ base: './src/content/places', pattern: '**/*.{md,mdx}' }),
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

/** What an administrator may write as a template's marketplace listing. Values for the form's choice lists must be ones the form offers. */
import { z } from 'zod';
import { ALLOWED, SUBCATEGORIES } from './neozaarConfig';

const oneOf = (allowed: readonly string[]) => z.string().refine((v) => allowed.includes(v), { message: `must be one of: ${allowed.join(', ')}` });
const text = (max: number) => z.string().trim().min(1).max(max);

export const ListingSchema = z.object({
  challenges: text(2000).optional(),
  outcomes: z.array(text(500)).min(1).max(12).optional(),
  pricingModel: oneOf(ALLOWED.pricingModel).optional(),
  startingPrice: z.number().finite().min(0).max(1e9).optional(),
  audience: z.array(oneOf(ALLOWED.targetAudience)).min(1).max(16).optional(),
  segments: z.array(oneOf(ALLOWED.targetSegments)).min(1).max(8).optional(),
  industries: z.array(oneOf(ALLOWED.industry)).min(1).max(18).optional(),
  ctaModels: z.array(oneOf(ALLOWED.ctaModel)).min(1).max(4).optional(),
  regions: z.array(text(60)).min(1).max(20).optional(),
  category: oneOf(ALLOWED.category).optional(),
  subCategory: text(80).optional(),
  differentiator: text(1000).optional(),
  termsOfUseUrl: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), { message: 'must be an http or https address' }).optional(),
}).strict().superRefine((l, ctx) => {
  // A sub-category is checked against the known ones when the category's are known; a category whose sub-categories we do not have takes any text.
  const cat = l.category;
  if (l.subCategory && cat && SUBCATEGORIES[cat] && !SUBCATEGORIES[cat]!.includes(l.subCategory)) ctx.addIssue({ code: 'custom', path: ['subCategory'], message: `must be one of: ${SUBCATEGORIES[cat]!.join(', ')}` });
});

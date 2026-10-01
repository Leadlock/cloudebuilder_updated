/**
 * Usage limits for Terraform runs, adjustable by the operator.
 *
 *   CLOUDCRAFT_TERRAFORM_PLANS_PER_WINDOW   plans one user may generate per window (default 6)
 *   CLOUDCRAFT_TERRAFORM_PLAN_WINDOW_MINUTES  length of that window in minutes (default 10)
 *
 * Plans are read-only but heavy (terraform init + plan on the server), so they are limited per user. Applies are not
 * counted here: they are already limited to one at a time per project (projectLock.ts).
 */
const intFromEnv = (name: string, fallback: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function planLimit(): { limit: number; windowMs: number; windowMinutes: number } {
  const windowMinutes = intFromEnv('CLOUDCRAFT_TERRAFORM_PLAN_WINDOW_MINUTES', 10, 1, 24 * 60);
  return { limit: intFromEnv('CLOUDCRAFT_TERRAFORM_PLANS_PER_WINDOW', 6, 1, 1000), windowMs: windowMinutes * 60_000, windowMinutes };
}

export const planRateKey = (userId: string) => `${userId}:terraform-plan`;

/** Whether a configuration runs a ready-made image. Lives apart from dockerTemplates.ts so the deployment modules can use it without importing it. */
export const usesExistingImage = (c: { image: string }): boolean => c.image !== '';

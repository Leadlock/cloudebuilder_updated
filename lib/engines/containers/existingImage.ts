/**
 * Running an image that already exists, instead of building one: what is accepted, and why some images are not.
 *
 * Accepted: a public image, named like Docker does (nginx:1.27, ghcr.io/you/app:1.0, quay.io/org/tool@sha256:...). Every deployment target pulls
 * it as it is. Not accepted: images in the private registries of AWS (ECR) and Azure (ACR). Pulling those needs the target to be given access
 * to somebody else's registry, which is a permission decision CloudBuilder will not make for you silently; build from source instead (the
 * deployment then creates a registry of its own and gives the target exactly the access it needs) or make the image public.
 */

/** [registry host and port]/[path]:tag or @digest, all lowercase, as the Docker and Kubernetes tools write them. */
export const IMAGE_REF = /^[a-z0-9][a-z0-9._-]*(?::[0-9]{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

const PRIVATE_REGISTRY = /(^|\/)[^/]*\.dkr\.ecr(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/|(^|\/)[^/]*\.azurecr\.(io|cn|us)\//i;

export function validateExistingImage(image: string): string[] {
  if (image === '') return [];
  if (image.length > 255 || !IMAGE_REF.test(image)) return ['Image: use the name Docker uses, in lowercase, for example nginx:1.27 or ghcr.io/yourname/yourapp:1.0.'];
  if (PRIVATE_REGISTRY.test(`${image}/`) || PRIVATE_REGISTRY.test(image)) return ['Image: images in a private AWS (ECR) or Azure (ACR) registry cannot be used here, because the deployment would need access to a registry it does not own. Use a public image, or leave this empty and build from source: the deployment then creates its own registry and gets exactly the access it needs.'];
  return [];
}

/** True when the image has no version: Docker would pull "latest". */
export function imageIsFloating(image: string): boolean {
  if (image.includes('@sha256:')) return false;
  const last = image.split('/').pop() ?? '';
  return !last.includes(':') || last.endsWith(':latest');
}

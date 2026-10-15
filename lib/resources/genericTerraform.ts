/**
 * Which resources may become a generic Terraform block (lib/resources/catalog/universalHcl.ts) when the generator has no template of its own.
 *
 * A generic block is written from the type's name (aws_vpc_endpoint becomes resource "aws_vpc_endpoint"), so it is only right for a type that
 * is a defined, real resource. Two kinds of type must never become one, and keep the old answer ("Unsupported resource type", nothing written):
 *  - a type nobody defined (a typo, an old or foreign type): there is no such Terraform resource;
 *  - a box that is only drawn on the canvas, such as the cloud boundary around a whole diagram: it has no Terraform resource either.
 */
import { getResourceDefinition } from './index';

/** Types that exist only on the canvas. */
export const CANVAS_ONLY_TYPES: ReadonlySet<string> = new Set(['aws_cloud_boundary', 'azure_cloud_boundary']);

/** Whether a type with no template of its own may become a generic Terraform block. */
export const canGenerateGenericBlock = (type: string): boolean => !CANVAS_ONLY_TYPES.has(type) && getResourceDefinition(type) !== undefined;

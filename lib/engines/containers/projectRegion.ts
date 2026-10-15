/**
 * The region chosen for the project (top bar) is also where the deployment goes: an AWS project's region fills the EC2 and ECS regions, an Azure
 * project's region fills the location of the Azure VM, Container Apps and AKS settings. The other cloud's settings are left alone, because a
 * region of one cloud means nothing in the other. A value that is not a valid region of that cloud is ignored.
 */
import type { ContainerConfig } from './dockerTemplates';
import { LOCATION, REGION } from './shared';


export function withProjectRegion(c: ContainerConfig, provider: string | undefined, region: string | undefined): ContainerConfig {
  if (!region) return c;
  if (provider === 'aws' && REGION.test(region)) {
    return { ...c, ec2: { ...c.ec2, region }, ecs: { ...c.ecs, region } };
  }
  if (provider === 'azure' && LOCATION.test(region)) {
    return { ...c, azvm: { ...c.azvm, location: region }, aca: { ...c.aca, location: region }, aks: { ...c.aks, location: region } };
  }
  return c;
}

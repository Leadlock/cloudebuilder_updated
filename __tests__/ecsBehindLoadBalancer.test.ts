/**
 * Fargate services behind a load balancer, with the routes and security groups they need to work.
 * Reproduces the "Microservices on ECS Fargate" design: the plan used to build, but nothing could reach anything.
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

const res = (id: string, resourceType: string, name: string, config: Record<string, unknown> = {}, groupId: string | null = null): DbArchitectureResource => ({
  id, resourceType, provider: 'aws', label: name, positionX: 0, positionY: 0, configJson: JSON.stringify({ name, ...config }), region: null, groupId, locked: false, architectureId: 'a',
} as DbArchitectureResource);
const conn = (sourceId: string, targetId: string, label: string | null = null): DbArchitectureConnection => ({ id: `${sourceId}-${targetId}`, label, edgeType: null, sourceId, targetId, architectureId: 'a' });

function design(opts: { nat?: boolean; routeTable?: boolean; svcSg?: boolean; labels?: boolean; oneService?: boolean } = {}) {
  const resources = [
    res('vpc', 'aws_vpc', 'main_vpc'),
    res('pub_a', 'aws_subnet', 'public_a', { mapPublicIpOnLaunch: true }, 'vpc'),
    res('pub_b', 'aws_subnet', 'public_b', { mapPublicIpOnLaunch: true }, 'vpc'),
    res('priv', 'aws_subnet', 'private_services', {}, 'vpc'),
    res('igw', 'aws_igw', 'igw', {}, 'vpc'),
    res('alb', 'aws_alb', 'web_alb', { listenerProtocol: 'HTTP' }, 'vpc'),
    res('orders', 'aws_ecs', 'orders_svc', { containerPort: 8080 }, 'priv'),
    ...(opts.oneService ? [] : [res('inv', 'aws_ecs', 'inventory_svc', { containerPort: 80 }, 'priv')]),
    res('db', 'aws_rds', 'orders_db', { engine: 'postgres', engineVersion: '16', port: 5432 }, 'priv'),
    ...(opts.svcSg === false ? [] : [res('sg', 'aws_sg', 'services_sg', {}, 'vpc')]),
    ...(opts.nat ? [res('nat', 'aws_nat', 'nat', {}, 'pub_a')] : []),
    ...(opts.routeTable ? [res('rt', 'aws_route_table', 'my_rt', {}, 'vpc')] : []),
  ];
  const connections = [
    conn('alb', 'pub_a'), conn('alb', 'pub_b'),
    conn('alb', 'orders', opts.labels === false ? null : 'Route /orders'),
    ...(opts.oneService ? [] : [conn('alb', 'inv', opts.labels === false ? null : 'Route /inventory')]),
    ...(opts.svcSg === false ? [] : [conn('sg', 'orders'), conn('sg', 'inv')]),
    conn('orders', 'db'),
  ];
  const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  return { main: r.files.find((f) => f.filename === 'main.tf')!.content, warnings: r.warnings, blocking: r.blocking ?? [] };
}
const block = (main: string, header: string) => { const i = main.indexOf(header); return i < 0 ? '' : main.slice(i, main.indexOf('\n}\n', i) + 2); };

describe('Fargate services behind the load balancer', () => {
  const d = design();

  test('each service gets its own IP target group (Fargate cannot use instance targets) and a path rule', () => {
    for (const svc of ['orders_svc', 'inventory_svc']) {
      const tg = block(d.main, `resource "aws_lb_target_group" "web_alb_${svc}_tg"`);
      expect(tg).toContain('target_type = "ip"');
      expect(block(d.main, `resource "aws_lb_listener_rule" "web_alb_${svc}_rule"`)).toContain(`aws_lb_target_group.web_alb_${svc}_tg.arn`);
    }
    expect(d.main).not.toContain('resource "aws_lb_target_group" "web_alb_tg"');          // the placeholder instance group is gone
    expect(block(d.main, 'resource "aws_lb_target_group" "web_alb_orders_svc_tg"')).toContain('port        = 8080');   // the container's own port
  });

  test('paths come from the wires\' labels', () => {
    expect(block(d.main, 'resource "aws_lb_listener_rule" "web_alb_orders_svc_rule"')).toContain('values = ["/orders", "/orders/*"]');
    expect(block(d.main, 'resource "aws_lb_listener_rule" "web_alb_inventory_svc_rule"')).toContain('values = ["/inventory", "/inventory/*"]');
  });

  test('anything else gets a 404, not a forward to a service that does not own the path', () => {
    expect(block(d.main, 'resource "aws_lb_listener" "web_alb_listener"')).toContain('status_code  = "404"');
  });

  test('the service registers with its target group, and waits for the rule (or AWS refuses the service)', () => {
    const svc = block(d.main, 'resource "aws_ecs_service" "orders_svc"');
    expect(svc).toContain('target_group_arn = aws_lb_target_group.web_alb_orders_svc_tg.arn');
    expect(svc).toContain('container_name   = "orders_svc"');
    expect(svc).toContain('container_port   = 8080');
    expect(svc).toContain('depends_on = [aws_lb_listener_rule.web_alb_orders_svc_rule]');
  });

  test('priorities are unique and target group names are valid (32 characters, letters digits hyphens)', () => {
    const priorities = [...d.main.matchAll(/priority\s+=\s+(\d+)/g)].map((m) => m[1]);
    expect(new Set(priorities).size).toBe(priorities.length);
    for (const m of d.main.matchAll(/resource "aws_lb_target_group"[^{]*\{\s*name\s+=\s+"([^"]+)"/g)) expect(m[1]).toMatch(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/);
  });

  test('a single unlabelled service takes every path', () => {
    const one = design({ oneService: true, labels: false });
    expect(block(one.main, 'resource "aws_lb_listener_rule" "web_alb_orders_svc_rule"')).toContain('values = ["/*"]');
  });

  test('several unlabelled services are told apart by name', () => {
    const many = design({ labels: false });
    expect(block(many.main, 'resource "aws_lb_listener_rule" "web_alb_orders_svc_rule"')).toContain('"/orders"');
    expect(block(many.main, 'resource "aws_lb_listener_rule" "web_alb_inventory_svc_rule"')).toContain('"/inventory"');
  });
});

describe('security groups', () => {
  const d = design();
  test('a load balancer with no security group gets one that admits its listener port', () => {
    const sg = block(d.main, 'resource "aws_security_group" "web_alb_sg"');
    expect(sg).toContain('from_port   = 80');
    expect(sg).toContain('cidr_blocks = ["0.0.0.0/0"]');
    expect(block(d.main, 'resource "aws_lb" "web_alb"')).toContain('security_groups    = [aws_security_group.web_alb_sg.id]');
  });
  test('the services admit the load balancer on their own container port', () => {
    const rule = block(d.main, 'resource "aws_security_group_rule" "web_alb_to_orders_svc"');
    expect(rule).toContain('from_port                = 8080');
    expect(rule).toContain('source_security_group_id = aws_security_group.web_alb_sg.id');
    expect(rule).toContain('security_group_id        = aws_security_group.services_sg.id');
  });
  test('a service with no security group of its own is reported', () => {
    expect(design({ svcSg: false }).warnings.join(' ')).toMatch(/orders_svc.*no security group.*load balancer cannot reach it/);
  });
  test('a database with no security group admits the services wired to it, on its port', () => {
    const sg = block(d.main, 'resource "aws_security_group" "orders_db_sg"');
    expect(sg).toContain('from_port       = 5432');
    expect(sg).toContain('security_groups = [aws_security_group.services_sg.id]');
    expect(block(d.main, 'resource "aws_db_instance" "orders_db"')).toMatch(/vpc_security_group_ids\s+= \[aws_security_group\.orders_db_sg\.id\]/);
  });
});

describe('routes', () => {
  test('public subnets are routed to the internet gateway', () => {
    const d = design();
    expect(block(d.main, 'resource "aws_route_table" "main_vpc_public_rt"')).toContain('gateway_id = aws_internet_gateway.igw.id');
    expect(d.main).toContain('resource "aws_route_table_association" "public_a_public_assoc"');
    expect(d.main).toContain('resource "aws_route_table_association" "public_b_public_assoc"');
    expect(d.main).not.toContain('"private_services_public_assoc"');
  });
  test('with a NAT gateway the private subnets are routed through it', () => {
    const d = design({ nat: true });
    expect(block(d.main, 'resource "aws_route_table" "main_vpc_private_rt"')).toContain('nat_gateway_id = aws_nat_gateway.nat.id');
    expect(d.main).toContain('resource "aws_route_table_association" "private_services_private_assoc"');
    expect(d.warnings.join(' ')).not.toMatch(/no route to the internet/);
  });
  test('without a NAT gateway the user is told the tasks cannot pull their image', () => {
    const d = design();
    expect(d.main).not.toContain('main_vpc_private_rt');
    expect(d.warnings.join(' ')).toMatch(/no route to the internet.*cannot pull their container image/);
  });
  test('a design that draws its own route tables is left exactly as drawn', () => {
    const d = design({ routeTable: true });
    expect(d.main).not.toContain('main_vpc_public_rt');
    expect(d.main).not.toContain('_public_assoc');
  });
});

describe('what was already right stays right', () => {
  test('an ECS service with no load balancer is generated as before', () => {
    const resources = [res('vpc', 'aws_vpc', 'v'), res('sn', 'aws_subnet', 'a_sub', {}, 'vpc'), res('svc', 'aws_ecs', 'worker_svc', {}, 'sn')];
    const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections: [] });
    const main = r.files.find((f) => f.filename === 'main.tf')!.content;
    expect(block(main, 'resource "aws_ecs_service" "worker_svc"')).not.toContain('load_balancer');
    expect(main).not.toContain('aws_lb_listener_rule');
  });
});

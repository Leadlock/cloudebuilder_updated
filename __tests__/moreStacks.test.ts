/**
 * Go, .NET and Ruby stacks, and the extra compose services (MySQL, MongoDB, RabbitMQ) and the Caddy HTTPS proxy.
 * The generated files are parsed (YAML) and read; `scripts/build-samples.ts` builds and runs them with Docker in CI.
 */
import { parse } from 'yaml';
import { checkContainer } from '@/lib/engines/containers/checks';
import { defaultConfig, generateContainerFiles, STACK_LABEL, STACKS, validate, VERSIONS, withDeployTarget, type ContainerConfig, type ContainerStack } from '@/lib/engines/containers/dockerTemplates';
import { containerConfigFromNode, nodeConfigFromContainer, nodeProblems } from '@/lib/engines/containers/nodeConfig';
import { getResourceDefinition } from '@/lib/resources';

const cfg = (stack: ContainerStack, over: Partial<ContainerConfig> = {}): ContainerConfig => ({ ...defaultConfig(stack), appName: 'orders-api', ...over });
function gen(c: ContainerConfig) {
  const r = generateContainerFiles(c);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { ...r, by: Object.fromEntries(r.files.map((f) => [f.path, f.content])) as Record<string, string> };
}
const errs = (c: ContainerConfig) => validate(c).join(' | ');

describe('stacks', () => {
  it('every stack has a label, versions, a default port and generates a valid, non-root template', () => {
    expect(STACKS).toEqual(['node', 'python', 'java', 'go', 'dotnet', 'ruby', 'static']);
    for (const s of STACKS) {
      expect(STACK_LABEL[s]).toBeTruthy();
      expect(VERSIONS[s].length).toBeGreaterThan(0);
      const c = cfg(s, { includeSample: true });
      expect(errs(c)).toBe('');
      const { by } = gen(c);
      expect(by['Dockerfile']).toMatch(/^HEALTHCHECK /m);
      if (s !== 'static') expect(by['Dockerfile']).toMatch(/^USER app(user)?$/m);
      expect(parse(by['docker-compose.yml']!).services['orders-api']).toBeTruthy();
    }
  });

  describe('Go', () => {
    it('builds a static binary in a small Alpine image and runs it as a non-root user', () => {
      const d = gen(cfg('go')).by['Dockerfile']!;
      expect(d).toContain('FROM golang:1.23-alpine AS build');
      expect(d).toContain('CGO_ENABLED=0 go build -trimpath');
      expect(d).toContain('go mod download');
      expect(d).toContain('FROM alpine:3.20 AS runtime');
      expect(d).toContain('ENTRYPOINT ["/app/app"]');
      expect(d).toContain('ENV PORT=8080');
    });
    it('validates the package', () => {
      expect(errs(cfg('go', { goPackage: './cmd/server' }))).toBe('');
      for (const bad of ['', 'cmd/server', '../x', './a/../b', '.; rm -rf /', './a b']) expect(errs(cfg('go', { goPackage: bad }))).toMatch(/Go package/);
    });
    it('the sample is a single main package with a go.mod matching the version', () => {
      const { by } = gen(cfg('go', { includeSample: true, version: '1.22' }));
      expect(by['go.mod']).toBe('module example.com/orders-api\n\ngo 1.22\n');
      expect(by['main.go']).toContain('package main');
      expect(by['main.go']).toContain('os.Getenv("PORT")');
      expect(generateContainerFiles(cfg('go', { includeSample: true, goPackage: './cmd/x' }))).toMatchObject({ ok: true, warnings: [expect.stringContaining('single main package')] });
    });
  });

  describe('.NET', () => {
    it('publishes with the SDK and runs the assembly on the Alpine ASP.NET image', () => {
      const d = gen(cfg('dotnet', { dotnetProject: 'src/Api/Api.csproj', dotnetAssembly: 'Api' })).by['Dockerfile']!;
      expect(d).toContain('FROM mcr.microsoft.com/dotnet/sdk:9.0-alpine AS build');
      expect(d).toContain('dotnet publish src/Api/Api.csproj -c Release -o /out /p:UseAppHost=false');
      expect(d).toContain('FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS runtime');
      expect(d).toContain('ASPNETCORE_URLS=http://+:8080');
      expect(d).toContain('ENTRYPOINT ["dotnet", "Api.dll"]');
    });
    it('validates the project and assembly', () => {
      for (const bad of ['App.sln', '../App.csproj', 'a b.csproj', '/abs/App.csproj', '']) expect(errs(cfg('dotnet', { dotnetProject: bad }))).toMatch(/project file/);
      for (const bad of ['', '1App', 'A pp', 'A"b']) expect(errs(cfg('dotnet', { dotnetAssembly: bad }))).toMatch(/assembly name/);
    });
    it('the sample sits next to the configured project and names the assembly', () => {
      const { by } = gen(cfg('dotnet', { includeSample: true, dotnetProject: 'src/Api/Api.csproj', dotnetAssembly: 'Api', version: '8.0' }));
      expect(by['src/Api/Api.csproj']).toContain('<TargetFramework>net8.0</TargetFramework>');
      expect(by['src/Api/Api.csproj']).toContain('<AssemblyName>Api</AssemblyName>');
      expect(by['src/Api/Program.cs']).toContain('MapGet("/health"');
    });
  });

  describe('Ruby', () => {
    it('Rack: installs gems in a build stage and runs rackup on the port', () => {
      const d = gen(cfg('ruby')).by['Dockerfile']!;
      expect(d).toContain('FROM ruby:3.3-slim AS build');
      expect(d).toContain('bundle install');
      expect(d).toContain('CMD ["sh", "-c", "bundle exec rackup config.ru -o 0.0.0.0 -p 3000"]');
      expect(d).not.toContain('assets:precompile');
      expect(d).toContain('Net::HTTP.get_response');
    });
    it('Rails precompiles assets without a real secret and serves static files; "other" runs your command', () => {
      const r = gen(cfg('ruby', { rubyFramework: 'rails' })).by['Dockerfile']!;
      expect(r).toContain('SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile');
      expect(r).toContain('RAILS_ENV=production');
      expect(r).toContain('bin/rails server -b 0.0.0.0 -p 3000');
      expect(gen(cfg('ruby', { rubyFramework: 'other', startCommand: 'bundle exec puma -C config/puma.rb' })).by['Dockerfile']).toContain('bundle exec puma -C config/puma.rb');
      expect(errs(cfg('ruby', { rubyFramework: 'other', startCommand: '  ' }))).toMatch(/Start command is required/);
    });
    it('the Rack sample is three gems and a config.ru; other frameworks get no sample', () => {
      const { by } = gen(cfg('ruby', { includeSample: true }));
      expect(by['Gemfile']).toContain('gem "puma"');
      expect(by['config.ru']).toContain('run lambda');
      expect(generateContainerFiles(cfg('ruby', { includeSample: true, rubyFramework: 'rails' }))).toMatchObject({ ok: true, warnings: [expect.stringContaining('available for Rack')] });
    });
  });

  it('found by building for real: a Node project with no dependencies still builds, and .NET does not clash with the image\'s own "app" user', () => {
    expect(gen(cfg('node')).by['Dockerfile']).toContain('RUN npm ci && mkdir -p node_modules');
    expect(gen(cfg('node', { packageManager: 'pnpm' })).by['Dockerfile']).toContain('pnpm install --frozen-lockfile && mkdir -p node_modules');
    const d = gen(cfg('dotnet')).by['Dockerfile']!;
    expect(d).toContain('adduser --system --uid 1001 --ingroup appuser appuser');
    expect(d).toMatch(/^USER appuser$/m);
    expect(d).not.toMatch(/addgroup --system --gid 1001 app &&/);
  });

  it('the new stacks run as the same numeric user on Kubernetes (the Dockerfile user is 1001)', () => {
    for (const s of ['go', 'dotnet', 'ruby'] as const) {
      const c = withDeployTarget(cfg(s), 'kubernetes'); c.k8s.image = 'ghcr.io/acme/app:1';
      expect(parse(gen(c).by['k8s/deployment.yaml']!).spec.template.spec.containers[0].securityContext.runAsUser).toBe(1001);
      expect(gen(cfg(s)).by['Dockerfile']).toContain('--uid 1001');
    }
  });

  it('every deployment target accepts the new stacks', () => {
    for (const s of ['go', 'dotnet', 'ruby'] as const) {
      for (const t of ['ec2', 'ecs', 'container-apps', 'kubernetes'] as const) {
        const c = withDeployTarget(cfg(s), t); c.k8s.image = 'ghcr.io/acme/app:1';
        expect(errs(c)).toBe('');
      }
    }
  });

  it('the canvas node accepts them and still produces a valid configuration', () => {
    const stacks = getResourceDefinition('aws_container_service')!.configSchema.find((f) => f.key === 'stack')!.options!.map((o) => o.value);
    expect(stacks).toEqual(STACKS);
    for (const s of ['go', 'dotnet', 'ruby'] as const) {
      const n = nodeConfigFromContainer(withDeployTarget(cfg(s), 'ec2'));
      expect(containerConfigFromNode(n).stack).toBe(s);
      expect(nodeProblems(n)).toEqual([]);
    }
  });
});

describe('compose services', () => {
  const all = () => cfg('node', { postgres: true, redis: true, mysql: true, mongodb: true, rabbitmq: true });

  it('each service is added with a health check, a named volume, and a connection URL for the app', () => {
    const { by } = gen(all());
    const y = parse(by['docker-compose.yml']!);
    expect(Object.keys(y.services)).toEqual(['orders-api', 'postgres', 'redis', 'mysql', 'mongodb', 'rabbitmq']);
    for (const s of ['postgres', 'redis', 'mysql', 'mongodb', 'rabbitmq']) expect(y.services[s].healthcheck.test).toBeTruthy();
    expect(Object.keys(y.volumes)).toEqual(['pgdata', 'mysqldata', 'mongodata', 'rabbitdata']);
    const env = y.services['orders-api'].environment;
    expect(env['MYSQL_URL']).toBe('mysql://orders_api:${MYSQL_PASSWORD:?set MYSQL_PASSWORD}@mysql:3306/orders_api');
    expect(env['MONGODB_URL']).toBe('mongodb://orders_api:${MONGODB_PASSWORD:?set MONGODB_PASSWORD}@mongodb:27017/orders_api?authSource=admin');
    expect(env['RABBITMQ_URL']).toBe('amqp://orders_api:${RABBITMQ_PASSWORD:?set RABBITMQ_PASSWORD}@rabbitmq:5672');
    expect(Object.keys(y.services['orders-api'].depends_on)).toEqual(['postgres', 'redis', 'mysql', 'mongodb', 'rabbitmq']);
  });
  it('no password is a value in any file: all come from the environment, and .env.example asks for them blank', () => {
    const { by } = gen(all());
    for (const [name, v] of [['mysql', 'MYSQL_PASSWORD'], ['mongodb', 'MONGODB_PASSWORD'], ['rabbitmq', 'RABBITMQ_PASSWORD']] as const) {
      const svc = parse(by['docker-compose.yml']!).services[name];
      expect(JSON.stringify(svc.environment)).toContain(`\${${v}:?set ${v}}`);
    }
    expect(by['.env.example']).toMatch(/^POSTGRES_PASSWORD=$/m);
    for (const n of ['MYSQL_PASSWORD', 'MONGODB_PASSWORD', 'RABBITMQ_PASSWORD']) expect(by['.env.example']).toMatch(new RegExp(`^${n}=$`, 'm'));
  });
  it('MySQL: random root password, user limited to the app database, ping uses the app user', () => {
    const m = parse(gen(cfg('node', { mysql: true })).by['docker-compose.yml']!).services.mysql;
    expect(m.environment.MYSQL_RANDOM_ROOT_PASSWORD).toBe('yes');
    expect(m.environment.MYSQL_DATABASE).toBe('orders_api');
    expect(m.healthcheck.test[1]).toContain('mysqladmin ping');
    expect(m.healthcheck.test[1]).toContain('$$MYSQL_PASSWORD'); // compose passes a literal $ on to the shell
  });
  it('a database user name over MySQL\'s 32 characters is refused', () => {
    expect(errs(cfg('node', { mysql: true, appName: 'a'.repeat(33) }))).toMatch(/32 characters/);
    expect(errs(cfg('node', { mysql: false, appName: 'a'.repeat(33) }))).toBe('');
  });
  it('none of them is published to the host, and the checks agree', () => {
    const c = all();
    const y = parse(gen(c).by['docker-compose.yml']!);
    for (const s of ['postgres', 'redis', 'mysql', 'mongodb', 'rabbitmq']) expect(y.services[s].ports).toBeUndefined();
    expect(checkContainer(c, gen(c).files).map((f) => f.id)).not.toContain('CT-008');
    expect(gen(c).by['README.md']).toContain('MySQL 8.4');
  });
  it('nothing extra is added when nothing is chosen', () => {
    const y = parse(gen(cfg('node')).by['docker-compose.yml']!);
    expect(Object.keys(y.services)).toEqual(['orders-api']);
    expect(y.volumes).toBeUndefined();
  });
  it('a deployment target says the companions are not deployed', () => {
    const c = withDeployTarget(cfg('node', { mysql: true }), 'ecs');
    expect(gen(c).warnings.join(' ')).toMatch(/PostgreSQL and Redis are not started|are not started/);
  });
});

describe('HTTPS reverse proxy', () => {
  const withProxy = (over: Partial<ContainerConfig> = {}) => cfg('node', { proxy: true, proxyDomain: 'app.example.com', ...over });

  it('publishes only the proxy: 80 and 443, and the app is exposed to it over the compose network', () => {
    const y = parse(gen(withProxy()).by['docker-compose.yml']!);
    expect(y.services.proxy.ports).toEqual(['80:80', '443:443', '443:443/udp']);
    expect(y.services['orders-api'].ports).toBeUndefined();
    expect(y.services['orders-api'].expose).toEqual(['3000']);
    expect(y.services.proxy.depends_on['orders-api'].condition).toBe('service_healthy');
    expect(Object.keys(y.volumes)).toEqual(['caddy_data', 'caddy_config']);
  });
  it('the proxy is hardened: no capabilities except binding low ports, no new privileges', () => {
    const p = parse(gen(withProxy()).by['docker-compose.yml']!).services.proxy;
    expect(p.cap_drop).toEqual(['ALL']);
    expect(p.cap_add).toEqual(['NET_BIND_SERVICE']);
    expect(p.security_opt).toContain('no-new-privileges:true');
  });
  it('the Caddyfile forwards to the app and sets security headers', () => {
    const f = gen(withProxy()).by['Caddyfile']!;
    expect(f).toContain('{$DOMAIN} {');
    expect(f).toContain('reverse_proxy orders-api:3000');
    expect(f).toContain('Strict-Transport-Security');
    expect(parse(gen(withProxy()).by['docker-compose.yml']!).services.proxy.environment.DOMAIN).toBe('app.example.com');
  });
  it('localhost works and a real domain is checked', () => {
    expect(errs(withProxy({ proxyDomain: 'localhost' }))).toBe('');
    for (const bad of ['', 'http://x.com', 'a b.com', 'x', 'a..com', 'x.com/path', '-a.com']) expect(errs(withProxy({ proxyDomain: bad }))).toMatch(/HTTPS proxy/);
    expect(errs(cfg('node', { proxy: false, proxyDomain: 'nonsense!' }))).toBe('');
  });
  it('the README gives the HTTPS address, and the build context ignores the Caddyfile', () => {
    const { by } = gen(withProxy());
    expect(by['README.md']).toContain('https://app.example.com');
    expect(by['README.md']).toContain('Let\'s Encrypt');
    expect(by['.dockerignore']!.split('\n')).toContain('Caddyfile');
    expect(gen(cfg('node')).by['Caddyfile']).toBeUndefined();
  });
  it('is not reported as a database on the host, and a deployment target is told it does not use it', () => {
    const c = withProxy();
    expect(checkContainer(c, gen(c).files).map((f) => f.id)).not.toContain('CT-008');
    expect(gen(withDeployTarget(withProxy(), 'ec2')).warnings.join(' ')).toMatch(/HTTPS proxy is part of docker-compose.yml only/);
    expect(gen(withProxy()).warnings.join(' ')).not.toMatch(/HTTPS proxy is part/);
  });
});

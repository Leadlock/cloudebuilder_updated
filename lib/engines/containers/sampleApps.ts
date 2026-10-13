/**
 * Tiny sample applications, one per stack, so a template works end to end before you have your own code:
 * "Include a sample app" adds the files below next to the Dockerfile, and `docker build` / `bash deploy.sh` produce a running service
 * that answers on "/" and on the health check path.
 *
 * Kept deliberately small: Go and .NET use only their standard libraries, Ruby is a three-gem Rack app, Node uses only the standard library, Python pins two packages, Java is a minimal Spring Boot project,
 * the static site is one HTML page. Every value taken from the form (name, port) was validated before it gets here.
 */
import type { ContainerConfig, GeneratedFile } from './dockerTemplates';

export interface SampleResult { files: GeneratedFile[]; warnings: string[] }

const NODE_LOCK = (name: string) => `${JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } } }, null, 2)}\n`;

function nodeSample(c: ContainerConfig): SampleResult {
  if (c.nextStandalone) return { files: [], warnings: ['Sample app: not added, because "Next.js standalone output" expects a Next.js project. Turn it off to use the sample.'] };
  const pkg = { name: c.appName, version: '1.0.0', private: true, scripts: { build: 'echo "nothing to build"', start: 'node server.js' } };
  const server = `const http = require('http');

const port = Number(process.env.PORT) || ${c.port};

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: ${JSON.stringify(c.appName)}, message: 'Hello from CloudCraft', path: req.url, time: new Date().toISOString() }));
  })
  .listen(port, '0.0.0.0', () => console.log('listening on ' + port));
`;
  return {
    files: [
      { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
      { path: 'package-lock.json', content: NODE_LOCK(c.appName) },
      { path: 'server.js', content: server },
    ],
    warnings: c.packageManager !== 'npm' ? ['Sample app: it ships a package-lock.json, so use npm as the package manager.'] : [],
  };
}

function pythonSample(c: ContainerConfig): SampleResult {
  if (c.pythonFramework === 'fastapi') {
    const [mod] = c.pythonModule.split(':');
    const file = `${mod!.split('.').join('/')}.py`;
    return {
      files: [
        { path: 'requirements.txt', content: 'fastapi==0.115.0\nuvicorn==0.30.6\n' },
        { path: file, content: `from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"app": ${JSON.stringify(c.appName)}, "message": "Hello from CloudCraft"}


@app.get("/health")
def health():
    return {"status": "ok"}
` },
      ],
      warnings: c.healthPath !== '/' && c.healthPath !== '/health' ? [`Sample app: it answers on "/" and "/health", not on ${c.healthPath}.`] : [],
    };
  }
  if (c.pythonFramework === 'flask') {
    const [mod, attr] = c.pythonModule.split(':');
    const file = `${mod!.split('.').join('/')}.py`;
    return {
      files: [
        { path: 'requirements.txt', content: 'flask==3.0.3\ngunicorn==22.0.0\n' },
        { path: file, content: `from flask import Flask, jsonify

${attr} = Flask(__name__)


@${attr}.get("/")
def root():
    return jsonify(app=${JSON.stringify(c.appName)}, message="Hello from CloudCraft")


@${attr}.get("/health")
def health():
    return jsonify(status="ok")
` },
      ],
      warnings: c.healthPath !== '/' && c.healthPath !== '/health' ? [`Sample app: it answers on "/" and "/health", not on ${c.healthPath}.`] : [],
    };
  }
  return { files: [], warnings: ['Sample app: available for FastAPI and Flask. Choose one of them to use it.'] };
}

function javaSample(c: ContainerConfig): SampleResult {
  if (c.javaBuildTool !== 'maven') return { files: [], warnings: ['Sample app: available for Maven. Choose Maven to use it.'] };
  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
    <relativePath/>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>${c.appName}</artifactId>
  <version>0.0.1</version>
  <properties>
    <java.version>${c.version}</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`;
  const app = `package com.example.demo;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class Application {
  public static void main(String[] args) {
    SpringApplication.run(Application.class, args);
  }

  @GetMapping("/")
  public Map<String, String> root() {
    return Map.of("app", ${JSON.stringify(c.appName)}, "message", "Hello from CloudCraft");
  }
}
`;
  return {
    files: [
      { path: 'pom.xml', content: pom },
      { path: 'src/main/java/com/example/demo/Application.java', content: app },
      { path: 'src/main/resources/application.properties', content: 'management.endpoints.web.exposure.include=health\nmanagement.endpoint.health.probes.enabled=true\n' },
    ],
    warnings: c.healthPath !== '/actuator/health' && c.healthPath !== '/' ? [`Sample app: it answers on "/" and "/actuator/health", not on ${c.healthPath}.`] : [],
  };
}

function staticSample(c: ContainerConfig): SampleResult {
  const dir = c.staticBuildDir;
  const pkg = { name: c.appName, version: '1.0.0', private: true, scripts: { build: `mkdir -p ${dir} && cp -r public/. ${dir}/` } };
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${c.appName}</title>
  </head>
  <body>
    <h1>${c.appName}</h1>
    <p>Hello from CloudCraft.</p>
  </body>
</html>
`;
  return {
    files: [
      { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
      { path: 'package-lock.json', content: NODE_LOCK(c.appName) },
      { path: 'public/index.html', content: html },
    ],
    warnings: c.buildCommand.trim() !== 'npm run build' ? ['Sample app: its build script is "npm run build". Your build command is different.'] : [],
  };
}

function goSample(c: ContainerConfig): SampleResult {
  if (c.goPackage !== '.') return { files: [], warnings: ['Sample app: it is a single main package at the project root. Set the Go package to "." to use it.'] };
  const main = `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "${c.port}"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"app": ${JSON.stringify(c.appName)}, "message": "Hello from CloudCraft", "path": r.URL.Path, "time": time.Now().UTC().Format(time.RFC3339),
		})
	})
	log.Println("listening on " + port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
`;
  return { files: [{ path: 'go.mod', content: `module example.com/${c.appName.replace(/_/g, '-')}\n\ngo ${c.version}\n` }, { path: 'main.go', content: main }], warnings: [] };
}

function dotnetSample(c: ContainerConfig): SampleResult {
  const dir = c.dotnetProject.includes('/') ? c.dotnetProject.slice(0, c.dotnetProject.lastIndexOf('/') + 1) : '';
  const csproj = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net${c.version}</TargetFramework>
    <AssemblyName>${c.dotnetAssembly}</AssemblyName>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
`;
  const program = `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", (HttpRequest request) => Results.Json(new { app = ${JSON.stringify(c.appName)}, message = "Hello from CloudCraft", path = request.Path.Value, time = DateTime.UtcNow }));
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.Run();
`;
  return { files: [{ path: c.dotnetProject, content: csproj }, { path: `${dir}Program.cs`, content: program }], warnings: c.healthPath === '/' ? [] : c.healthPath === '/health' ? [] : [`Sample app: it answers on "/" and "/health". Your health check path is ${c.healthPath}.`] };
}

function rubySample(c: ContainerConfig): SampleResult {
  if (c.rubyFramework !== 'rack') return { files: [], warnings: ['Sample app: available for Rack. Choose Rack to use it.'] };
  const gemfile = `source "https://rubygems.org"

gem "rack", "~> 3.1"
gem "rackup", "~> 2.2"
gem "puma", "~> 6.4"
`;
  const ru = `require "json"

run lambda { |env|
  body = JSON.generate(app: ${JSON.stringify(c.appName)}, message: "Hello from CloudCraft", path: env["PATH_INFO"], time: Time.now.utc.iso8601)
  [200, { "content-type" => "application/json" }, [body]]
}
`;
  return { files: [{ path: 'Gemfile', content: gemfile }, { path: 'config.ru', content: ru }], warnings: [] };
}

export function generateSampleApp(c: ContainerConfig): SampleResult {
  if (!c.includeSample) return { files: [], warnings: [] };
  return ({ node: nodeSample, python: pythonSample, java: javaSample, go: goSample, dotnet: dotnetSample, ruby: rubySample, static: staticSample } as const)[c.stack](c);
}

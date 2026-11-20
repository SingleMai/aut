import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Package edges follow AGENTS.md; implementation subpaths stay behind the composition root.
export const allowedDependencies = {
  "@aut/characters": [],
  "@aut/protocol": [],
  "@aut/classifier": ["@aut/protocol"],
  "@aut/adapters": ["@aut/protocol"],
  "@aut/mcp-bridge": ["@aut/protocol"],
  "@aut/core": ["@aut/protocol", "@aut/classifier", "@aut/adapters", "@aut/mcp-bridge"],
  "@aut/daemon": [
    "@aut/protocol",
    "@aut/classifier",
    "@aut/adapters",
    "@aut/mcp-bridge",
    "@aut/core",
  ],
  "@aut/desktop": ["@aut/characters", "@aut/protocol"],
};

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist"].includes(entry.name) ? [] : sourceFiles(path);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

export function checkBoundaries(root) {
  const errors = [];
  const packages = ["packages", "apps"].flatMap((group) => {
    const directory = resolve(root, group);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      const manifest = resolve(path, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) return [];
      return [{ path, manifest: JSON.parse(readFileSync(manifest, "utf8")) }];
    });
  });

  for (const pkg of packages) {
    const name = pkg.manifest.name;
    const allowed = allowedDependencies[name];
    if (!allowed) {
      errors.push(`${name}: package has no architecture policy`);
      continue;
    }
    const dependencies = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
      ...pkg.manifest.peerDependencies,
      ...pkg.manifest.optionalDependencies,
    };
    for (const dependency of Object.keys(dependencies)) {
      if (dependency.startsWith("@aut/") && !allowed.includes(dependency)) {
        errors.push(`${name}: forbidden package dependency ${dependency}`);
      }
    }
    if (name === "@aut/protocol") {
      for (const dependency of Object.keys({
        ...pkg.manifest.dependencies,
        ...pkg.manifest.optionalDependencies,
        ...pkg.manifest.peerDependencies,
      })) {
        if (dependency !== "effect") errors.push(`${name}: runtime dependency must be effect`);
      }
    }

    for (const file of sourceFiles(pkg.path)) {
      const isTest = /\.test\.[cm]?[jt]sx?$/.test(file);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const report = (message) => errors.push(`${relative(root, file)}: ${message}`);
      const check = (specifier) => {
        let target;
        if (specifier.startsWith("@aut/")) {
          const packageName = specifier.split("/").slice(0, 2).join("/");
          target = packages.find((candidate) => candidate.manifest.name === packageName);
          if (!target) return report(`unknown workspace package ${packageName}`);
          if (packageName !== name && !dependencies[packageName]) {
            report(`undeclared dependency ${packageName}`);
          }
          if (packageName !== name && !allowed.includes(packageName)) {
            report(`forbidden import ${specifier}`);
          }
          if (
            name === "@aut/core" &&
            ["@aut/adapters", "@aut/classifier"].includes(packageName) &&
            specifier !== `${packageName}/interface`
          ) {
            report(`core may only import ${packageName}/interface`);
          }
        } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
          const path = resolve(dirname(file), specifier);
          if (!inside(pkg.path, path))
            report(`cross-package path import ${specifier}; use package exports`);
        } else if (
          name === "@aut/protocol" &&
          specifier !== "effect" &&
          !specifier.startsWith("effect/") &&
          !(
            isTest &&
            (specifier === "vitest" ||
              specifier === "@effect/vitest" ||
              specifier.startsWith("node:"))
          )
        ) {
          report(`protocol may only import effect, received ${specifier}`);
        }
      };
      const visit = (node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          if (ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
        }
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        ) {
          check(node.argument.literal.text);
        }
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          const value = node.moduleReference.expression;
          if (value && ts.isStringLiteral(value)) check(value.text);
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument)) check(argument.text);
          else report("computed module imports cannot be checked; use a literal specifier");
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Workspace dependency boundaries passed.");
  }
}

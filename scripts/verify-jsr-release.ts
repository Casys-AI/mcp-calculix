interface PackageMetadata {
  name?: string;
  version?: string;
}

interface RekorEntry {
  attestation?: {
    data?: string;
  };
}

interface ProvenanceStatement {
  type?: string;
  subject?: Array<{
    name?: string;
    digest?: { sha256?: string };
  }>;
  predicateType?: string;
  predicate?: {
    buildDefinition?: {
      resolvedDependencies?: Array<{
        uri?: string;
        digest?: { gitCommit?: string };
      }>;
      externalParameters?: {
        workflow?: {
          ref?: string;
          repository?: string;
          path?: string;
        };
      };
    };
  };
}

const [checkout, requestedVersion, requestedCommit] = Deno.args;
if (!checkout || !requestedVersion || !requestedCommit) {
  throw new Error(
    "Usage: verify-jsr-release.ts <checkout> <version> <commit>",
  );
}
if (!/^[0-9a-f]{40}$/.test(requestedCommit)) {
  throw new Error("The requested Git commit must be a full lowercase SHA-1.");
}

const packageMetadata = JSON.parse(
  await Deno.readTextFile(`${checkout}/deno.json`),
) as PackageMetadata;
if (
  packageMetadata.name !== "@casys/mcp-calculix" ||
  packageMetadata.version !== requestedVersion
) {
  throw new Error(
    `Checkout identity does not match @casys/mcp-calculix@${requestedVersion}.`,
  );
}

const packagePage = await fetch(
  `https://jsr.io/${packageMetadata.name}@${requestedVersion}`,
);
if (!packagePage.ok) {
  throw new Error(
    `JSR release page is unavailable for ${packageMetadata.name}@${requestedVersion}: ${packagePage.status}.`,
  );
}

const provenanceIndexes = new Set(
  [...(await packagePage.text()).matchAll(
    /https:\/\/search\.sigstore\.dev\/\?logIndex=([0-9]+)/g,
  )].map((match) => match[1]),
);
if (provenanceIndexes.size !== 1) {
  throw new Error(
    `Expected one JSR provenance entry, received ${provenanceIndexes.size}.`,
  );
}

const [logIndex] = provenanceIndexes;
const rekorResponse = await fetch(
  `https://rekor.sigstore.dev/api/v1/log/entries?logIndex=${logIndex}`,
);
if (!rekorResponse.ok) {
  throw new Error(
    `Rekor provenance entry ${logIndex} is unavailable: ${rekorResponse.status}.`,
  );
}

const rekorEntries = Object.values(
  await rekorResponse.json() as Record<string, RekorEntry>,
);
if (rekorEntries.length !== 1) {
  throw new Error(
    `Expected one Rekor entry for ${logIndex}, received ${rekorEntries.length}.`,
  );
}

const encodedStatement = rekorEntries[0].attestation?.data;
if (!encodedStatement) {
  throw new Error(`Rekor entry ${logIndex} has no provenance statement.`);
}
const statement = JSON.parse(
  new TextDecoder().decode(Uint8Array.fromBase64(encodedStatement)),
) as ProvenanceStatement;

const expectedTag = `v${requestedVersion}`;
const expectedRepository = "https://github.com/Casys-AI/mcp-calculix";
const expectedPurl = `pkg:jsr/${packageMetadata.name}@${requestedVersion}`;
const subject = statement.subject?.find((item) => item.name === expectedPurl);
if (!subject || !/^[0-9a-f]{64}$/.test(subject.digest?.sha256 ?? "")) {
  throw new Error(`Provenance subject does not bind ${expectedPurl}.`);
}

const source = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
  (dependency) =>
    dependency.uri ===
      `git+${expectedRepository}@refs/tags/${expectedTag}` &&
    dependency.digest?.gitCommit === requestedCommit,
);
if (!source) {
  throw new Error(
    `JSR provenance does not bind ${expectedTag} to ${requestedCommit}.`,
  );
}

const workflow = statement.predicate?.buildDefinition?.externalParameters
  ?.workflow;
if (
  statement.type !== "https://in-toto.io/Statement/v1" ||
  statement.predicateType !== "https://slsa.dev/provenance/v1" ||
  workflow?.ref !== `refs/tags/${expectedTag}` ||
  workflow.repository !== expectedRepository ||
  workflow.path !== ".github/workflows/publish.yml"
) {
  throw new Error("JSR provenance names an unexpected publishing workflow.");
}

const publishedModule = await import(
  `jsr:@casys/mcp-calculix@${requestedVersion}`
);
if (typeof publishedModule.getToolByName !== "function") {
  throw new Error("Published module contract is missing getToolByName().");
}

console.log(
  `Verified JSR release ${packageMetadata.name}@${requestedVersion} from ${requestedCommit} (Rekor ${logIndex}).`,
);

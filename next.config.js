const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Pin the workspace root to this project — otherwise Next's root inference
  // can walk up to an unrelated sibling project's lockfile/postcss config.
  turbopack: {
    root: path.join(__dirname),
  },
};

module.exports = nextConfig;

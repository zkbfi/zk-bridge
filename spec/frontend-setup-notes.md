# Frontend setup notes (from the originating developer, received 2026-10-19)

Recorded verbatim in substance. These notes are part of the specification under review.

To prevent dependency version mismatches—which can easily break WebAssembly (WASM) and cryptographic libraries in the browser you should use a standard Next.js framework setup running Tailwind CSS, shadcn/ui (optional), and the modern Viem/Wagmi stack

## Phase 1: Initialize the Project via Terminal

```bash
# 1. Create a modern Next.js project with TypeScript and Tailwind CSS configured
npx create-next-app@latest frontend --typescript --tailwind --eslint --app

# 2. Change directory into your newly generated frontend directory
cd frontend

# 3. Install core blockchain infrastructure packages (Viem + Wagmi)
npm install viem@2.x wagmi@2.x @tanstack/react-query

# 4. Install the official Succinct SDK for client-side browser proving
npm install @succinctlabs/sp1-sdk

# 5. Install the browser worker loader plugin to cleanly package zkProver.worker.ts
npm install --save-dev worker-loader
```

## Phase 2: The Next.js Configuration Patch (next.config.mjs)

Because the @succinctlabs/sp1-sdk uses complex WebAssembly binary files under the hood to calculate ZK math inside the browser, the standard Next.js bundler will throw module compilation errors out of the box.
You must update the next.config.mjs file in the root of the frontend/ folder with this configuration to allow WASM streaming and handle Web Worker routing:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // 1. Enable WebAssembly execution parameters
    config.experiments = { ...config.experiments, asyncWebAssembly: true };

    // 2. Fix target browser node polyfills for cryptographic libraries
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }

    // 3. Configure the Web Worker loader path
    config.module.rules.push({
      test: /\.worker\.(ts|js)$/,
      use: { loader: "worker-loader" },
    });

    return config;
  },
};

export default nextConfig;
```

## Phase 3: Launching the App

```bash
npm run dev
```

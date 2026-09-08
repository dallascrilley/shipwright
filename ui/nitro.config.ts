import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const rootRequire = createRequire(import.meta.url);
const coreRequire = createRequire(rootRequire.resolve("@agent-native/core"));
// nf3 is owned by @agent-native/core and is not linked at the app root, so
// resolve its plugin from that package's dependency graph at config load time.
const { externals } = await import(pathToFileURL(coreRequire.resolve("nf3/plugin")).href);
const nativeTraceInclude = ["fs-native-extensions"];

export default {
  traceDeps: nativeTraceInclude,
  traceOpts: {
    fullTraceInclude: nativeTraceInclude,
  },
  hooks: {
    "rollup:before": (_nitro, rollupConfig) => {
      const nativeTracePlugin = externals({
        rootDir: process.cwd(),
        traceInclude: nativeTraceInclude,
        trace: {
          outDir: _nitro.options.output.serverDir,
          fullTraceInclude: nativeTraceInclude,
          writePackageJson: true,
        },
      });
      // Nitro's Rolldown builder runs post-build tracing from buildEnd; nf3's
      // published plugin exposes that handler as writeBundle for Rollup.
      const { writeBundle: traceNativeDependencies, ...nativeTracePluginHooks } =
        nativeTracePlugin;
      rollupConfig.plugins ??= [];
      rollupConfig.plugins.push({
        ...nativeTracePluginHooks,
        buildEnd: async () => {
          await traceNativeDependencies.handler();
        },
      });
    },
  },
};

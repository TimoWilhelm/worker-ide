/**
 * vite-host-deploy worker — a second deployment of the {@link ViteHostWorker}
 * build engine, dedicated to one-shot production deploy builds.
 *
 * It runs the exact same code as `vite-host-worker` but as a distinct Cloudflare
 * Worker, so deploy builds get their own isolate pool. A heavy deploy build
 * therefore never shares a 128 MB isolate with the interactive preview rebuilds
 * served by `vite-host-worker`, keeping preview responsive (and deploys from
 * OOMing on an isolate already warmed by preview traffic).
 *
 * The preview Durable Object invokes this over the `VITE_HOST_DEPLOY` service
 * binding for `buildForDeploy`; the `hostDevelopment: true` preview path stays
 * on `VITE_HOST`.
 */
export { default } from '../vite-host/index';

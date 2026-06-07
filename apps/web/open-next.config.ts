import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No ISR/incremental cache yet; everything is static + client-side.
// The R2 incremental cache comes once film pages need ISR.
export default defineCloudflareConfig({});

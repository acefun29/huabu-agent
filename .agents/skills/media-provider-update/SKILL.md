---
name: media-provider-update
description: Update Huabu's built-in image, video, and audio provider/model configuration from current vendor-owned documentation. Use for media catalog refreshes, model additions/deprecations, API credential onboarding details, and provider protocol changes; not for chat-model configuration.
metadata:
  short-description: 更新花布媒体供应商配置
---

# Huabu Media Provider Update

Use this skill when changing media-provider support in this repository. The live catalog and adapter code are authoritative for what Huabu currently implements; the inventory in [references/current-providers.md](references/current-providers.md) is a dated snapshot to speed up discovery, not a claim that the snapshot is complete or still current.

## Workflow

1. Read the repository's `AGENTS.md`, this skill's provider inventory, and the current code under `src/main/media/catalog/`, `src/main/media/adapters/`, `src/main/media/adapters/registry.ts`, `src/main/media/catalog/index.ts`, `src/shared/media.ts`, and `src/renderer/src/components/settings/MediaTab.tsx`. Confirm the actual paths before editing; the catalog, adapter registry, settings options, and shared provider-type union can have different responsibilities.
2. Re-check the chosen vendor's current model availability, exact API model ID, region, endpoint, authentication, access prerequisites, and lifecycle on the date of the task. Use vendor-owned API docs, product docs, console guidance, or repositories/specifications published by that vendor. Do not use third-party blogs, model aggregators, unofficial gateways, or community posts as evidence. Record direct official links and the date checked.
3. Decide whether the change is catalog-only or needs protocol work. Reuse an existing adapter only when its documented request, response, auth, polling, download, cancellation, and reference-media behavior match the vendor API. Do not infer missing request fields or capabilities from a similar provider. If the protocol differs, implement a distinct adapter and wire it through every source of truth required by the current architecture.
4. Keep the stable local model `id` separate from the vendor `remoteModel`. Preserve existing IDs. Set `kind` and `capabilities` only from official model-specific support: ratios, durations, reference roles and quotas, extras, and beta/deprecated state. A media card must not advertise a capability the selected model or adapter cannot send correctly.
5. Keep credential onboarding precise. Point to the vendor's official credential page and explain required format/region. Never ask the user to paste a secret into source, chat, a task note, a probe, or `workspace.json`; use the existing encrypted credential flow or environment fallback. Treat Aliyun DashScope and Aliyun Token Plan as separate credentials/endpoints. Treat Tencent CAM `SecretId:SecretKey` signing credentials and Tencent TokenHub Bearer API keys as separate products and adapters.
6. Prefer the generic custom-provider UI when a user's endpoint already matches an implemented protocol. Add a built-in provider only when it is a first-party provider integration that benefits from a maintained catalog or has a protocol Huabu does not already implement.
7. Update the inventory's snapshot only when the task asks for repository documentation or a provider change makes its facts outdated. Include the current local model IDs, actual vendor IDs, credential entry point, protocol/region caveats, official sources, and check date. Avoid hard-coding prices or calling a model “latest” without a dated official source.
8. Follow the user's verification request and repository rules. When verification is requested, start with focused checks such as `pnpm catalog:check`, `pnpm lint`, and the affected adapter tests; run broader suites only when requested or required by the task. Do not run live generation or spend provider credits unless the user explicitly asks. Do not commit unless asked, and stage only files for this provider change.

## Repository invariants

- A built-in provider is a data definition under `src/main/media/catalog/providers/`, imported by `src/main/media/catalog/index.ts`.
- Each `adapter` must be registered in `src/main/media/adapters/` and included by the adapters barrel. `MediaProviderType`, adapter support for each `MediaKind`, catalog sanitization, custom-provider UI options, key handling, and model capability validation must agree.
- For an existing adapter, use the provider's native protocol contract. OpenAI-compatible media support covers only the endpoint family implemented by `gateway-openai-compat`; it does not imply every provider using “OpenAI-compatible” chat also supports its image, video, or speech endpoints.
- Reference media delivery is an adapter constraint as well as a model capability. Keep public-URL, data-URI, multipart, vendor-upload, size, MIME, and role limits explicit. Never silently discard an unsupported reference type.
- `status: 'deprecated'` preserves old task replay while hiding a model from new selection. Only mark or remove a model using the vendor's current lifecycle evidence; preserve its stable local ID when status changes.
- The workspace credential UI stores secrets through the existing encrypted store. Source files and inventory documents contain only variable names and official help URLs, never credentials.

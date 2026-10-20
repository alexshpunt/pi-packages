---
name: "imagegen"
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when the agent should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

<!--
Modified copy of the "imagegen" skill bundled with OpenAI Codex
(codex-rs/skills/src/assets/samples/imagegen/SKILL.md, retrieved 2026-10-05).
Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0 (see LICENSE.txt and NOTICE).
Modified for Pi's `image_gen` tool: the CLI fallback mode and its files were removed, the Codex
image-viewing tool became Pi's `read` tool, local files are edited through `referenced_image_paths`,
the save path is the Pi agent directory, and the tool reuses Pi's existing `openai-codex`
ChatGPT subscription login without changing the chat provider.
-->

# Image Generation Skill

Generates or edits images for the current project (for example website assets, game assets, UI mockups, product mockups, wireframes, logo design, photorealistic images, or infographics).

## Tool and rules

This skill uses the `image_gen` tool for image generation, editing, and transparent-image requests. It uses the ChatGPT Plus/Pro subscription login that Pi manages for the `openai-codex` provider. If that login is not configured, use `/login openai-codex`. Reuse the existing login; a chat-model/provider change is not required.

Rules:
- Use the `image_gen` tool for normal image generation and editing requests.
- For transparent images, ask `image_gen` for a transparent background and preserve the generated alpha.
- If the user asks for many assets or says to batch-generate assets, issue one `image_gen` call per requested asset or variant.
- If the `image_gen` tool cannot be used (it is not available or it fails), tell the user. If the cause is missing authentication, ask the user to use `/login openai-codex`; reuse an existing login rather than asking them to log in again. Never ask the user to paste tokens or keys in chat. Do not create a separate login flow or one-off API runners or scripts as a substitute.

Save-path policy:
- `image_gen` saves generated images under the Pi agent directory (default `~/.pi/agent`) as `generated_images/<session>/<call>.png` by default, and the tool result names the saved path.
- Do not describe or rely on OS temp as the default destination.
- The `image_gen` tool has no destination-path argument. If a specific location is needed, generate first and then move or copy the selected output from `<Pi agent directory>/generated_images/...`.
- Save-path precedence:
  1. If the user names a destination, move or copy the selected output there.
  2. If the image is meant for the current project, move or copy the final selected image into the workspace before finishing.
  3. If the image is only for preview or brainstorming, render it inline; the underlying file can remain at the default path under the Pi agent directory.
- Never leave a project-referenced asset only at the default path under the Pi agent directory.
- Do not overwrite an existing asset unless the user explicitly asked for replacement; otherwise create a sibling versioned filename such as `hero-v2.png` or `item-icon-edited.png`.

Prompt guidance lives in `references/prompting.md` and `references/sample-prompts.md`.

## When to use
- Generate a new image (concept art, product shot, cover, website hero)
- Generate a new image using one or more reference images for style, composition, or mood
- Edit an existing image (inpainting, lighting or weather transformations, background replacement, object removal, compositing, transparent background)
- Produce many assets or variants for one task

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap

## Decision tree

Think about two separate questions:

1. **Intent:** is this a new image or an edit of an existing image?
2. **Execution strategy:** is this one asset or many assets/variants?

Intent:
- If the user wants to modify an existing image while preserving parts of it, treat the request as **edit**.
- If the user provides images only as references for style, composition, mood, or subject guidance, treat the request as **generate**.
- If the user provides no images, treat the request as **generate**.

Edit semantics:
- Use `referenced_image_paths` when every target image has a local file path. The tool reads the files directly; pass absolute paths (a leading `~` is expanded), up to 5.
- If you have not seen a local image yet, use the `read` tool to inspect it before editing.
- Use `num_last_images_to_include` only when at least one target image has no local file path, such as an image the user attached in chat or an image generated earlier in the conversation. Set it to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both `referenced_image_paths` and `num_last_images_to_include`.
- If neither mechanism can include every target image, ask the user to attach the missing images again.
- For edits, preserve invariants aggressively and save non-destructively by default.

Execution strategy:
- Produce many assets or variants by issuing one `image_gen` call per requested asset or variant. Distinct assets need distinct calls.

Assume the user wants a new image unless they clearly ask to change an existing one.

## Workflow
1. Decide the intent: `generate` or `edit`.
2. Decide whether the output is preview-only or meant to be consumed by the current project.
3. Decide the execution strategy: single asset vs repeated `image_gen` calls.
4. Collect inputs up front: prompt(s), exact text (verbatim), constraints/avoid list, and any input images.
5. For every input image, label its role explicitly:
   - reference image
   - edit target
   - supporting insert/style/compositing input
6. If an edit target is a local file, pass its path in `referenced_image_paths` (inspect it with `read` first if you have not seen it). If an edit target exists only in the conversation, use `num_last_images_to_include`.
7. If the user asked for a photo, illustration, sprite, product image, banner, or other explicitly raster-style asset, use `image_gen` rather than substituting SVG/HTML/CSS placeholders. If the request is for an icon, logo, or UI graphic that should match existing repo-native SVG/vector/code assets, prefer editing those directly instead.
8. Augment the prompt based on specificity:
   - If the user's prompt is already specific and detailed, normalize it into a clear spec without adding creative requirements.
   - If the user's prompt is generic, add tasteful augmentation only when it materially improves output quality.
9. Use the `image_gen` tool.
10. For transparent-output requests, ask `image_gen` for a transparent background and preserve the generated alpha channel.
11. Inspect outputs and validate: subject, style, composition, text accuracy, and invariants/avoid items.
12. Iterate with a single targeted change, then re-check.
13. For preview-only work, render the image inline; the underlying file may remain at the default `<Pi agent directory>/generated_images/...` path.
14. For project-bound work, move or copy the selected artifact into the workspace and update any consuming code or references. Never leave a project-referenced asset only at the default `<Pi agent directory>/generated_images/...` path.
15. For batches or multi-asset requests, persist every requested deliverable final in the workspace unless the user explicitly asked to keep outputs preview-only. Discarded variants do not need to be kept unless requested.
16. Always report the final saved path(s) for any workspace-bound asset(s), plus the final prompt or prompt set.

## Transparent image requests

Ask `image_gen` for a genuinely transparent background and preserve its alpha.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Treat this as prompt-shaping guidance, not a closed schema. Use only the lines that help, and add a short extra labeled line when it materially improves clarity.

### Specificity policy

Use the user's prompt specificity to decide how much augmentation is appropriate:

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, you may add tasteful augmentation when it will materially improve the result.

Allowed augmentations:
- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:
- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Use-case taxonomy (exact slugs)

Classify each request into one of these buckets and keep the slug consistent across prompts and references.

Generate:
- photorealistic-natural — candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup — product/packaging shots, catalog imagery, merch concepts.
- ui-mockup — app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram — diagrams/infographics with structured layout and text.
- scientific-educational — classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- ads-marketing — campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- productivity-visual — slide, chart, workflow, and data-heavy business visuals.
- logo-brand — logo/mark exploration, vector-friendly.
- illustration-story — comics, children’s book art, narrative scenes.
- stylized-concept — style-driven concept art, 3D/stylized renders.
- historical-scene — period-accurate/world-knowledge scenes.

Edit:
- text-localization — translate/replace in-image text, preserve layout.
- identity-preserve — try-on, person-in-scene; lock face/body/pose.
- precise-object-edit — remove/replace a specific element (including interior swaps).
- lighting-weather — time-of-day/season/atmosphere changes only.
- background-extraction — transparent background / clean cutout. Ask `image_gen` for actual transparency.
- style-transfer — apply reference style while changing subject/scene.
- compositing — multi-image insert/merge with matched lighting/perspective.
- sketch-to-render — drawing/line art to photoreal render.

## Shared prompt schema

Use the following labeled spec as prompt scaffolding:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:
- `Asset type` and `Input images` are prompt scaffolding, not tool arguments.
- `Scene/backdrop` refers to the visual setting. It is not the same as the tool's `transparent_background` argument, which controls output transparency.
- Execution notes such as `Quality:`, `Input fidelity:`, masks, output format, and output paths are not `image_gen` tool arguments. Do not include them in the prompt as if they were.

Augmentation rules:
- Keep it short.
- Add only the details needed to improve the prompt materially.
- For edits, explicitly list invariants (`change only X; keep Y unchanged`).
- If any critical detail is missing and blocks success, ask a question; otherwise proceed.

## Examples

### Generation example (hero image)
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit example (invariants)
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

## Prompting best practices
- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use (ad, UI mock, infographic) to set the mode and polish level.
- Use camera/composition language for photorealism.
- Only use SVG/vector stand-ins when the user explicitly asked for vector output or a non-image placeholder.
- Quote exact text and specify typography + placement.
- For tricky words, spell them letter-by-letter and require verbatim rendering.
- For multi-image inputs, reference images by index and describe how they should be used.
- For edits, repeat invariants every iteration to reduce drift.
- Iterate with single-change follow-ups.
- If the prompt is generic, add only the extra detail that will materially help.
- If the prompt is already detailed, normalize it instead of expanding it.
- For transparent images, ask `image_gen` for actual transparency and preserve its alpha.

More principles: `references/prompting.md`.
Copy/paste specs: `references/sample-prompts.md`.

## Guidance by asset type
Asset-type templates (website assets, game assets, wireframes, logo) are consolidated in `references/sample-prompts.md`.

## Reference map
- `references/prompting.md`: prompting principles.
- `references/sample-prompts.md`: copy/paste prompt recipes.

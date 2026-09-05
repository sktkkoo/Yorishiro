# Twilight Café asset provenance

- Model: `room-polished.glb`, authored for oogakitakashi with Blender 5.1.1 and procedural modeling scripts, asset version 0.4.1 (rendering optimization of reviewed 0.4.0).
- SHA-256: `0501a667c08ca89e62cde27fc465ad27834b7278d8b379508cc2b32f3594f469`.
- Wood, brocade, courtyard and leaf albedo images were generated with OpenAI image_gen. Roughness, normal and contact-AO maps were produced by scripts and Blender.
- Courtyard: generated 1254 × 1254 image, then Gaussian blur radius 4.5 px applied with Pillow. The blurred result is embedded in the model.
- Leaf surface: generated 1254 × 1254 albedo shared by the two leaf materials.
- No external stock photographs or downloaded third-party 3D models are embedded. The user-provided room reference image is retained in the local authoring project and is not included here.
- This record describes provenance; generated images are not presented as CC0 stock photography.

The associated scene source uses the repository's source-code license. This provenance record does not grant additional rights to the reference image or change the repository's separate treatment of visual assets.

Version 0.4.1 replaces window/bottle refraction with front-face alpha blending. Geometry, UVs and all embedded image bytes are unchanged. Regenerate from an authored GLB with `node scripts/optimize-twilight-cafe.mjs INPUT OUTPUT` at repository root.

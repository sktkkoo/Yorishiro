# Twilight Café asset provenance

- Model: `room-polished.glb`, authored for oogakitakashi with Blender 5.1.1 and procedural modeling scripts, asset version 0.4.2 (rendering optimization and right-hand plant clearance fixes for reviewed 0.4.0).
- SHA-256: `0dbffb9fb8dca279a875a703583b3874be421831f46211f575284ec181645f62`.
- Wood, brocade, courtyard and leaf albedo images were generated with OpenAI image_gen. Roughness, normal and contact-AO maps were produced by scripts and Blender.
- Courtyard: generated 1254 × 1254 image, then Gaussian blur radius 4.5 px applied with Pillow. The blurred result is embedded in the model.
- Leaf surface: generated 1254 × 1254 albedo shared by the two leaf materials.
- No external stock photographs or downloaded third-party 3D models are embedded. The user-provided room reference image is retained in the local authoring project and is not included here.
- This record describes provenance; generated images are not presented as CC0 stock photography.

The associated scene source uses the repository's source-code license. This provenance record does not grant additional rights to the reference image or change the repository's separate treatment of visual assets.

Version 0.4.1 replaces window/bottle refraction with front-face alpha blending. Geometry, UVs and all embedded image bytes are unchanged. Regenerate from an authored GLB with `node scripts/optimize-twilight-cafe.mjs INPUT OUTPUT` at repository root.

Version 0.4.2 corrects the right-hand plants: the ivy pot moves 9 cm forward, hanging stems reach over the front edge of the sill and pass left of the adjacent flask, and both right-hand pots rise 4 mm for contact clearance. Affected position/normal attributes are updated without removing leaves or changing the 73,864 triangles. All materials (including optimized glass), images, UVs and index buffers remain unchanged. Triangle-intersection checks after reimport found no ivy crossings with the sill, window frame or adjacent flask.

Scene pack version 0.4.2 also adds the optional CC0 piano loop by holizna. Its source and license are recorded separately in [LICENSE](LICENSE). The audio file is excluded from Git and supplied through the local external asset store.

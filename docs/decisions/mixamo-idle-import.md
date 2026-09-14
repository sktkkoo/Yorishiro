# Pending Mixamo idle imports

Recorded 2026-09-15. **Import pending; neither motion is converted, reviewed, installed, or admitted to automatic playback.**

| User-reported file | Declared source | Intended use | Verified source hash |
| --- | --- | --- | --- |
| `Sad Idle.fbx` | Adobe Mixamo, according to the user | Brief, infrequent sad emotional context | Pending; bytes not read |
| `Warrior Idle.fbx` | Adobe Mixamo, according to the user | Infrequent stretch, only if the actual performance supports that interpretation | Pending; bytes not read |

The user reported these files in Downloads and authorized conversion and use. Exact-file access/move attempts returned macOS `PermissionError: Operation not permitted`; neither file was moved or modified. A single inventory of the permitted external asset directory did not find either file. This does not establish that either file is absent from Downloads. The intended receiving location is `../Yorishiro-assets/`, outside the public Git repository. No alternate access route or permission bypass was attempted by this audit.

Once source bytes are available, record their SHA-256, skeleton, sampling, original timeline, conversion settings, and resulting VRMA hash. Preserve the recorded rotations, fingers, timing, and supported root movement; do not substitute generated motion or smooth away an acting defect. Actual Yori wrist/shoulder review and compatibility with its continuing lower-body recording precede automatic admission. Neither title alone proves an idle or stretch is suitable.

## Official license sources checked

Adobe's [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html), checked 2026-09-15 (page marked updated 2021-09-14), states that Mixamo is free with an Adobe ID without a Creative Cloud subscription, and permits royalty-free personal, commercial, and nonprofit uses of its characters and animations. This supports use within a project; it is not a grant of an open-source license to the animation files.

Adobe's [General Terms of Use](https://www.adobe.com/legal/terms.html), checked 2026-09-15 (published/effective 2025-10-03), distinguish software/service rights from content-file rights. Section 3.6 permits modification and distribution of Content Files as part of an end-use product, while excluding standalone distribution. Section 1.2 gives applicable product-specific terms precedence. Keep the original FBX and converted VRMA outside public Git and retain this source record when embedding an approved result in Yorishiro. This summary does not replace the applicable Adobe terms.

The FAQ and cited content-file provision do not state a mandatory attribution line. Yorishiro records Adobe Mixamo in `CREDITS.md` for provenance; it does not claim attribution is required, that the assets are MIT-licensed, or that Adobe endorses Yorishiro. The exact downloaded file's accompanying terms, if any, remain uninspected together with its bytes.

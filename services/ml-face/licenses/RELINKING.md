# Decoder source and replacement instructions

The ML service uses shared LGPL libheif and libde265 decoder libraries. Copies
of the LGPL and GPL are under `/usr/share/common-licenses`; libheif's combined
licence is also supplied as `LICENSE-libheif-COPYING.txt`. The complete original
licences control their terms. Recipients must retain their ability to modify
these libraries and reverse engineer the combined work to debug modifications.
No service or image licence term should prohibit those activities.

## Extract the provided material

Use the exact verified candidate image digest from the artifact report. The
container does not need to run, have network access or receive credentials:

```sh
ml_image_ref='REPLACE_WITH_VERIFIED_IMAGE_DIGEST'
ml_source_container=$(docker create --network none --entrypoint /bin/true "$ml_image_ref")
mkdir -p ml-corresponding-source
docker cp "$ml_source_container:/app/licenses" ml-corresponding-source/licenses
docker cp "$ml_source_container:/usr/share/doc/libde265-0" ml-corresponding-source/libde265-0
docker cp "$ml_source_container:/usr/share/common-licenses" ml-corresponding-source/common-licenses
docker rm "$ml_source_container"
```

Verify each copied source archive using `corresponding-source-manifest.json`
and the modified decoder hashes in the exact image's licence-validation report.
The libheif `.dsc` contains the original and Debian archive checksums. Unpack
and build it in a Debian 13 environment with `dpkg-source -x` and the build
dependencies specified in `debian/control`, then `dpkg-buildpackage -b -uc -us`.
The original Debian packaging and build rules are supplied, rather than a
handwritten approximation of the library's build.

For the shipped modified libde265, extract the original and Debian source
archives from `libde265-0/source/`, retain Debian's patch series, and apply the
supplied `libde265-CVE-2026-88373.patch`. The supplied
`build-libde265-backport.sh` records every build flag, retained SONAME, package
construction step and exported decoder API comparison. Its `/native` workspace
paths match the service Dockerfile's named builder stage. Changing the decoder
implementation while keeping its public ABI does not require application source
modifications.

## Replace a compatible shared decoder

Use an interface-compatible library for the same architecture. Determine the
candidate's library paths from `ldd` on its `_pillow_heif` extension and libheif;
the image-bound report records that linkage. Typical Debian 13 paths are
`/usr/lib/aarch64-linux-gnu/` or `/usr/lib/x86_64-linux-gnu/`. Preserve
`libheif.so.1` and `libde265.so.0` SONAMEs and their symlinks.

Create a derived image with the rebuilt `.deb` packages or replacement library
files, run `ldconfig` as root during image construction, then return to the
image's ordinary UID 10001. For example:

```dockerfile
ARG ML_VERIFIED_IMAGE
FROM ${ML_VERIFIED_IMAGE}
USER root
COPY replacement-decoders/*.deb /tmp/replacement-decoders/
RUN dpkg -i /tmp/replacement-decoders/*.deb \
    && ldconfig \
    && rm -rf /tmp/replacement-decoders
USER 10001:10001
```

There is no runtime decoder hash allowlist or service signature gate that
prevents a compatible replacement. Model hashes validate model files and do
not restrict the LGPL library replacement. Keep the same model data for this
check. Run the codec/startup tests and a representative decode with network
disabled, then verify `ldd` and loaded-library paths before using the derived
image. A replacement must preserve required security fixes for production use.

This document provides the supported replacement route. It is not a claim that
an independently modified library or a recipient's installation has been tested.

## Distribution handling

If an image is transferred to a recipient or made downloadable, accompany it
with these notices, full licences and equivalent access to the corresponding
source and installation/replacement material. Keep the source available for the
applicable distribution period and place clear directions alongside the image
download. Include the supplied modified libde265 material; an upstream release
URL alone omits the shipped Lovelies and Debian changes. Do not use an image
registry's access controls to withhold sources or modification rights from a
recipient of that image.

The image-bound report also inventories the Debian base packages and all
installed Python/native notices. Preserve their licences and source access
requirements when distributing the complete image. Network use of the service
and transfer of a container image are different activities under the LGPL/GPL
terms; describe the actual delivery channel in the release record. No external
image/source publication or independent legal approval is claimed here.

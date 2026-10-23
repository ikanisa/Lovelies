# Pinned libpng build sources

These are the exact Debian 1.6.48-1+deb13u5 source archives and signed source
descriptor identified by `../../patches/libpng-backport/libpng-backport-manifest.json`.
The backport build verifies the original SHA-256 hashes, applies the recorded
patch without context fuzz, and retains the source/license notices in the final
runtime. No source version or checksum has been changed.

The original archive was retrieved from Debian's security pool. That pool
returned HTTP 404 for the pinned Debian patch archive, so its exact bytes and
the descriptor were retrieved from Debian's content-addressed snapshot archive:

- Original archive: `libpng1.6_1.6.48.orig.tar.gz`, SHA-256
  `b17e99026055727e8cba99160c3a9a7f9af788e9f786daeadded5a42243f1dd0`.
- Debian patch archive: [snapshot 3c5d25ad75193405cfe8c79a202c39b7d099173f](https://snapshot.debian.org/file/3c5d25ad75193405cfe8c79a202c39b7d099173f), SHA-256
  `b38d5929b9a6139f2ce02a0e831d0f3f5365410b050dc429ea079a73253fe97a`.
- Signed descriptor: [snapshot b1f1da5f3d882066c7aa0eb8aa3766644cea40ef](https://snapshot.debian.org/file/b1f1da5f3d882066c7aa0eb8aa3766644cea40ef), SHA-256
  `746ec351ac044becb16725b903aee2c53815da9f89630767b6edbb317a50f98e`.

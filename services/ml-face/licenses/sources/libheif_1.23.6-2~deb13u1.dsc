-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: libheif
Binary: libheif1, libheif-plugin-aomdec, libheif-plugin-aomenc, libheif-plugin-dav1d, libheif-plugin-ffmpegdec, libheif-plugin-j2kdec, libheif-plugin-j2kenc, libheif-plugin-jpegdec, libheif-plugin-jpegenc, libheif-plugin-kvazaar, libheif-plugin-libde265, libheif-plugin-rav1e, libheif-plugin-svtenc, libheif-plugin-x265, libheif-plugins-all, libheif-dev, libheif-examples, heif-thumbnailer, heif-gdk-pixbuf
Architecture: any
Version: 1.23.6-2~deb13u1
Maintainer: Debian Multimedia Maintainers <debian-multimedia@lists.debian.org>
Uploaders:  Joachim Bauch <fancycode@debian.org>
Homepage: http://www.libheif.org
Standards-Version: 4.7.4
Vcs-Browser: https://salsa.debian.org/multimedia-team/libheif
Vcs-Git: https://salsa.debian.org/multimedia-team/libheif.git
Testsuite: autopkgtest
Build-Depends: aom-tools, cmake, debhelper-compat (= 13), libaom-dev, libavcodec-dev, libdav1d-dev, libbrotli-dev, libde265-dev (>= 1.0.7), libgdk-pixbuf-2.0-dev, libjpeg-dev, libkvazaar-dev, libopenjp2-7-dev, libpng-dev, librav1e-dev [amd64 arm64 armel armhf mips64el mipsel powerpc ppc64 ppc64el riscv64 s390x], libsharpyuv-dev, libsvtav1enc-dev, libtiff-dev, libwebp-dev, libwebm-dev, libx265-dev, libyuv-dev, libz-dev, pkgconf
Package-List:
 heif-gdk-pixbuf deb graphics optional arch=any
 heif-thumbnailer deb graphics optional arch=any
 libheif-dev deb libdevel optional arch=any
 libheif-examples deb video optional arch=any
 libheif-plugin-aomdec deb libs optional arch=any
 libheif-plugin-aomenc deb libs optional arch=any
 libheif-plugin-dav1d deb libs optional arch=any
 libheif-plugin-ffmpegdec deb libs optional arch=any
 libheif-plugin-j2kdec deb libs optional arch=any
 libheif-plugin-j2kenc deb libs optional arch=any
 libheif-plugin-jpegdec deb libs optional arch=any
 libheif-plugin-jpegenc deb libs optional arch=any
 libheif-plugin-kvazaar deb libs optional arch=any
 libheif-plugin-libde265 deb libs optional arch=any
 libheif-plugin-rav1e deb libs optional arch=amd64,arm64,armel,armhf,mips64el,mipsel,powerpc,ppc64,ppc64el,riscv64,s390x
 libheif-plugin-svtenc deb libs optional arch=any
 libheif-plugin-x265 deb libs optional arch=any
 libheif-plugins-all deb libs optional arch=any
 libheif1 deb libs optional arch=any
Checksums-Sha1:
 092204a0715469ee0f84134c9db3e86375dec587 2373898 libheif_1.23.6.orig.tar.gz
 c984bcb9a448c2a77bd8d38103c330786e83621d 16116 libheif_1.23.6-2~deb13u1.debian.tar.xz
Checksums-Sha256:
 4484346dc5995319dbc11e3a1c35d0a2ec46511ce370900869337fd2c7033125 2373898 libheif_1.23.6.orig.tar.gz
 91802e614b0a78acbf0fd6a23937bbf6898a5c2188e1f002a9a9eef0da132f87 16116 libheif_1.23.6-2~deb13u1.debian.tar.xz
Files:
 1e95c96fc0d3b8c40023b4b1a7184dab 2373898 libheif_1.23.6.orig.tar.gz
 e9eff63d44cd14f80cb6be99d55d37e5 16116 libheif_1.23.6-2~deb13u1.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQEzBAEBCgAdFiEExq6D0hxncEPaPayX+GQ1dHE8m64FAmrazO4ACgkQ+GQ1dHE8
m66Mgwf+PikF51tx1ivjzUlTMgmqSSVq8EwO0pjuzUNR2dhFTb7HulRZyxZltVKC
vMT8ebPKnP6gh7xUFPR0iJGygr0pGzT/tf/zB2+BXFXlxthBO9XLVxBnsmM1SusP
NrD9gjUfXadtgpXgq6onfQgg+ytfwdQXN3ia41G1xNLmyehnsXsbp9RtHWLyAXQ0
YcGB3vaUoFyHTxKppLmNEm+dkbdhKdc9CyuLjcoEY0kLbdcgxOCZ2wDPZ/ZJaa1o
RGedlZRA/fsP9nMXgYIbhqepTc+xXaTg3aRFEnt8F+rokpTwAwqKXatcV/52mAPC
71IHCQYJ5BMgu1nUC1OnfcrSdH8FcQ==
=xrhY
-----END PGP SIGNATURE-----

-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: libheif
Binary: libheif1, libheif-plugin-aomdec, libheif-plugin-aomenc, libheif-plugin-dav1d, libheif-plugin-ffmpegdec, libheif-plugin-j2kdec, libheif-plugin-j2kenc, libheif-plugin-jpegdec, libheif-plugin-jpegenc, libheif-plugin-kvazaar, libheif-plugin-libde265, libheif-plugin-rav1e, libheif-plugin-svtenc, libheif-plugin-x265, libheif-plugins-all, libheif-dev, libheif-examples, heif-thumbnailer, heif-gdk-pixbuf
Architecture: any
Version: 1.23.4-1~deb13u1
Maintainer: Debian Multimedia Maintainers <debian-multimedia@lists.debian.org>
Uploaders:  Joachim Bauch <fancycode@debian.org>
Homepage: http://www.libheif.org
Standards-Version: 4.7.4
Vcs-Browser: https://salsa.debian.org/multimedia-team/libheif
Vcs-Git: https://salsa.debian.org/multimedia-team/libheif.git
Testsuite: autopkgtest
Build-Depends: aom-tools, cmake, debhelper-compat (= 13), libaom-dev, libavcodec-dev, libdav1d-dev, libbrotli-dev, libde265-dev (>= 1.0.7), libgdk-pixbuf-2.0-dev, libjpeg-dev, libkvazaar-dev [!loong64], libopenjp2-7-dev, libpng-dev, librav1e-dev [amd64 arm64 armel armhf mips64el mipsel powerpc ppc64 ppc64el riscv64 s390x], libsharpyuv-dev, libsvtav1enc-dev, libtiff-dev, libwebp-dev, libwebm-dev, libx265-dev, libyuv-dev, libz-dev, pkgconf
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
 f8ab778f373973dcada7c77236d711e1310cc26a 2217221 libheif_1.23.4.orig.tar.gz
 5b2ba1570b30816b0e1797aabf96fef6cd900ce3 15552 libheif_1.23.4-1~deb13u1.debian.tar.xz
Checksums-Sha256:
 d0c02b4b0e978f34a1974b6f3eea7975a537bf7a9195ffeea38e7242ff316fdd 2217221 libheif_1.23.4.orig.tar.gz
 5102677f6e7e98b9b80d19e7579617ae07fe56199e9c9ce91ce59c1e7a6e24aa 15552 libheif_1.23.4-1~deb13u1.debian.tar.xz
Files:
 9cd6d40e19496a839dc9a7ba0b750f76 2217221 libheif_1.23.4.orig.tar.gz
 2b2d426040be8e9a6f4f4e089f116d68 15552 libheif_1.23.4-1~deb13u1.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQEzBAEBCgAdFiEExq6D0hxncEPaPayX+GQ1dHE8m64FAmq2UMgACgkQ+GQ1dHE8
m6530Qf9EcTvUqeL0tKub+mT893kNhMVCw6bdi9lO2BuMsoCGHh9jTmpeoNDQnFo
sSlgXo0JLg+C88/+r42QyUDQ2xoqAdmVRMJZVSGdVtsJdIlSQwVrk8+WAhvsf7EO
mcniv9todUvAckFFTbHBIJgguzzsZzK6USKtTj2A11OD+t13omoMDbW/was5G9rr
mV1JSuEm/0TzXfbvKqtWy0GZKp4gXr4ExeiDmCC+cW8IprG9sbE09TVv+L+Q4POy
Lqdny0Qg+zH7qH8Z2mPFZxuW0a8LKjBBDzrc27ovLmeP7tQN/T3b4rmOx5EO445m
nLd8TSsMh5HV8LpEvSOfLG8VuWtQTw==
=jZk+
-----END PGP SIGNATURE-----

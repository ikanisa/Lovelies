#!/bin/sh
set -eu

# Exact publisher wrapper release92 and its OpenCV submodule, with a local
# image-only build. No publisher wheel is represented as this custom artifact.
ml_cv_wrapper=4ddfc013fd1f13d9b9e379dbebf2cdbeb052e7f8
ml_cv_source=b4c5ec4042f097e2a5b386b9d413ec7333d0a184
mkdir -p /opencv/source /opencv/out
tar -xzf /opencv/wrapper.tar.gz -C /opencv/source
tar -xzf /opencv/opencv.tar.gz -C /opencv/source
ml_cv_root="/opencv/source/opencv-python-$ml_cv_wrapper"
if [ -d "$ml_cv_root/opencv" ]; then rmdir "$ml_cv_root/opencv"; fi
mv "/opencv/source/opencv-$ml_cv_source" "$ml_cv_root/opencv"
cd "$ml_cv_root"
# Archive builds lack Git/tag metadata. This is the verified release identity,
# not a rolling revision or a change to the recognizer model version.
mkdir -p cv2
printf '%s\n' "opencv_version = '4.13.0.92'" 'contrib = False' \
    'headless = True' 'rolling = False' 'ci_build = False' > cv2/version.py
export ENABLE_HEADLESS=1 ENABLE_CONTRIB=0 ENABLE_JAVA=0 ENABLE_ROLLING=0 CI_BUILD=0
export CMAKE_BUILD_PARALLEL_LEVEL=2
export DEB_BUILD_MAINT_OPTIONS='hardening=+all future=+lfs'
eval "$(dpkg-buildflags --export=sh)"
export CMAKE_ARGS="-DBUILD_LIST=core,imgproc,imgcodecs,dnn,objdetect,python3
 -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_STANDARD=17 -DPYTHON3_LIMITED_API=ON
 -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_V4L=OFF -DWITH_OPENCL=OFF
 -DWITH_CUDA=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_TBB=OFF -DWITH_LAPACK=OFF
 -DWITH_QUIRC=OFF -DWITH_FLATBUFFERS=OFF -DOPENCV_DNN_TFLITE=OFF
 -DWITH_OPENEXR=OFF -DBUILD_OPENEXR=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF
 -DWITH_AVIF=OFF -DWITH_JPEG=ON -DBUILD_JPEG=OFF -DWITH_PNG=ON -DBUILD_PNG=OFF
 -DWITH_WEBP=ON -DBUILD_WEBP=OFF -DWITH_TIFF=OFF -DBUILD_TIFF=OFF
 -DBUILD_ZLIB=OFF -DWITH_PROTOBUF=ON -DBUILD_PROTOBUF=OFF -DPROTOBUF_UPDATE_FILES=ON"
# scikit-build tokenizes CMAKE_ARGS; compiler/linker flags must remain separate
# environment variables, which CMake reads on its first configure.
python setup.py bdist_wheel > /opencv/out/build.log 2>&1
cat /opencv/out/build.log
cp dist/opencv_python_headless-4.13.0.92-*.whl /opencv/out/
test "$(find /opencv/out -maxdepth 1 -name '*.whl' | wc -l)" -eq 1
cp LICENSE.txt LICENSE-3RD-PARTY.txt /opencv/out/
cp opencv/LICENSE /opencv/out/LICENSE-opencv.txt
find _skbuild -name CMakeCache.txt -exec cp '{}' /opencv/out/CMakeCache.txt \;
test -s /opencv/out/CMakeCache.txt
# Actual configuration must preserve intended absence and system parsers.
for ml_cv_flag in WITH_FFMPEG WITH_GSTREAMER BUILD_PROTOBUF BUILD_JPEG BUILD_PNG BUILD_WEBP; do
    grep -F "$ml_cv_flag:BOOL=OFF" /opencv/out/CMakeCache.txt
done
grep -E '(PROTOBUF|Protobuf)_LIBRARY[^:]*:.*=/usr/lib/' /opencv/out/CMakeCache.txt
grep -E 'JPEG_LIBRARY_RELEASE:.*=/usr/lib/' /opencv/out/CMakeCache.txt
grep -E 'PNG_LIBRARY_RELEASE:.*=/usr/lib/' /opencv/out/CMakeCache.txt
printf '%s\n' \
    'Lovelies custom image-only OpenCV build, 30 September 2026.' \
    "Publisher wrapper release92: $ml_cv_wrapper; OpenCV submodule: $ml_cv_source." \
    'Same Python distribution/version and face-model API; video, GUI and unused codecs are disabled.' \
    'JPEG, PNG, WebP and protobuf use Debian shared libraries. HEIF uses the separate decoder adapter.' \
    'Source archive hashes and local wheel hash are recorded separately from publisher wheel hashes.' \
    > /opencv/out/LOVELIES-MODIFICATION-NOTICE.txt
cp /opencv/build-opencv-image-only.sh /opencv/out/
chmod -R a+rX /opencv/out

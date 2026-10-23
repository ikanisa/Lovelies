// Bounded applicability probe for the entrypoint reported in upstream issue760.
// This test-only MessageLite returns a synthetic size; it allocates no large
// payload. The production service does not use this class or serialize models.
#include <google/protobuf/message_lite.h>
#include <sys/resource.h>

#include <climits>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

class SizedMessage final : public google::protobuf::MessageLite {
 public:
  explicit SizedMessage(std::size_t size) : size_(size) {}
  std::string GetTypeName() const override { return "BoundedSizeProbe"; }
  SizedMessage* New(google::protobuf::Arena*) const override {
    return new SizedMessage(size_);
  }
  void Clear() override {}
  bool IsInitialized() const override { return true; }
  void CheckTypeAndMergeFrom(const MessageLite&) override {}
  std::size_t ByteSizeLong() const override { return size_; }
  int GetCachedSize() const override { return static_cast<int>(size_); }
  std::uint8_t* _InternalSerialize(
      std::uint8_t* output,
      google::protobuf::io::EpsCopyOutputStream*) const override {
    if (size_ != 0) throw std::runtime_error("Oversize serializer was reached");
    return output;
  }

 private:
  std::size_t size_;
};

int main() {
  // A faulty implementation cannot allocate an actual multigigabyte string.
  // RLIMIT_AS also constrains Rosetta's address space reservation. RLIMIT_DATA
  // bounds heap and mmap allocations on this Linux kernel without blocking it.
  const rlimit limit{512 * 1024 * 1024, 512 * 1024 * 1024};
  if (setrlimit(RLIMIT_DATA, &limit) != 0) return 1;
  try {
    SizedMessage empty(0);
    std::string output;
    if (!empty.SerializeToString(&output) || !output.empty()) return 2;
    for (std::size_t size : {std::size_t(INT_MAX) + 1,
                             (std::size_t(1) << 32) + 1}) {
      SizedMessage oversize(size);
      output = "preserved";
      if (oversize.AppendPartialToString(&output) || output != "preserved") return 3;
      if (oversize.SerializeToString(&output) || !output.empty()) return 4;
      output = "preserved";
      if (oversize.SerializePartialToString(&output) || !output.empty()) return 5;
      std::uint8_t bounded[1] = {0x5a};
      if (oversize.SerializeToArray(bounded, sizeof bounded) ||
          bounded[0] != 0x5a) return 6;
      if (oversize.SerializePartialToArray(bounded, sizeof bounded) ||
          bounded[0] != 0x5a) return 6;
    }
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 7;
  }
  std::cout << "PASS: exact runtime rejects INT_MAX+1 and 4GiB+1 synthetic "
               "sizes before serialization/allocation; zero-size control passes\n";
}

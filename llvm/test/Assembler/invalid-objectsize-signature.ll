; RUN: not opt -S < %s 2>&1 | FileCheck %s

define i1 @test_invalid_objectsize_non_pointer() {
entry:
  ; CHECK: error: invalid intrinsic signature
  %0 = call i64 (...) @llvm.objectsize.i64.p0(i64 3, i1 false)
  %1 = icmp ugt i64 %0, 0
  ret i1 %1
}

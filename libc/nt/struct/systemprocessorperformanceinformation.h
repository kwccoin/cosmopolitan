#ifndef COSMOPOLITAN_LIBC_NT_STRUCT_SYSTEMPROCESSORPERFORMANCEINFORMATION_H_
#define COSMOPOLITAN_LIBC_NT_STRUCT_SYSTEMPROCESSORPERFORMANCEINFORMATION_H_
#if !(__ASSEMBLER__ + __LINKER__ + 0)

struct NtSystemProcessorPerformanceInformation {
  int64_t IdleTime;
  int64_t KernelTime;
  int64_t UserTime;
  int64_t Reserved1[2];
  uint32_t Reserved2;
};

#endif /* !(__ASSEMBLER__ + __LINKER__ + 0) */
#endif /* COSMOPOLITAN_LIBC_NT_STRUCT_SYSTEMPROCESSORPERFORMANCEINFORMATION_H_ \
        */
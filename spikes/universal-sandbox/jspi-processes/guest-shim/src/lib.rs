// Fast-path shim, instantiated once per process and linked wasm-to-wasm between an
// UNMODIFIED wasip1 guest and the kernel.
//
// Observed in Chromium 158: an import wrapped in WebAssembly.Suspending suspends and
// resumes the stack on every call, even when the JS function returns a plain number.
// So the guest's fd_read/fd_write imports are satisfied by these wasm functions, which
// first call a plain (non-suspending) JS import and only fall through to the Suspending
// import when the kernel says the call would block.
#![no_std]

#[link(wasm_import_module = "k")]
extern "C" {
    fn try_fd_write(fd: i32, iovs: i32, n: i32, pn: i32) -> i32; // plain import; -1 = would block
    fn slow_fd_write(fd: i32, iovs: i32, n: i32, pn: i32) -> i32; // Suspending import
    fn try_fd_read(fd: i32, iovs: i32, n: i32, pn: i32) -> i32;
    fn slow_fd_read(fd: i32, iovs: i32, n: i32, pn: i32) -> i32;
}

#[no_mangle]
pub extern "C" fn fd_write(fd: i32, iovs: i32, n: i32, pn: i32) -> i32 {
    unsafe {
        let r = try_fd_write(fd, iovs, n, pn);
        if r >= 0 { r } else { slow_fd_write(fd, iovs, n, pn) }
    }
}

#[no_mangle]
pub extern "C" fn fd_read(fd: i32, iovs: i32, n: i32, pn: i32) -> i32 {
    unsafe {
        let r = try_fd_read(fd, iovs, n, pn);
        if r >= 0 { r } else { slow_fd_read(fd, iovs, n, pn) }
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

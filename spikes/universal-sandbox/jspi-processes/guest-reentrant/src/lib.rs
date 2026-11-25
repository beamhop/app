// Tiny freestanding module for the "JS frames between wasm frames" JSPI test.
#![no_std]

#[link(wasm_import_module = "env")]
extern "C" {
    fn block(x: i32) -> i32; // Suspending import
    fn js_call(x: i32) -> i32; // plain JS import that calls back into `inner`
    fn js_call_susp(x: i32) -> i32; // Suspending import whose async JS awaits promising(inner)
}

#[no_mangle]
pub extern "C" fn inner(x: i32) -> i32 {
    unsafe { block(x) + 1 }
}

#[no_mangle]
pub extern "C" fn outer_direct(x: i32) -> i32 {
    unsafe { block(x) + 100 }
}

#[no_mangle]
pub extern "C" fn outer_via_js(x: i32) -> i32 {
    unsafe { js_call(x) + 1000 }
}

#[no_mangle]
pub extern "C" fn outer_via_js_susp(x: i32) -> i32 {
    unsafe { js_call_susp(x) + 1000 }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// Two consecutive calls to the Suspending import in one activation (used to observe
// whether a Suspending import that returns a plain value still yields to microtasks).
#[no_mangle]
pub extern "C" fn twice(x: i32) -> i32 {
    unsafe { block(x) + block(x) }
}

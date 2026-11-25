// parent CMDLINE...: spawns a child through a custom kernel import (child inherits
// fd 1/2), blocks in waitpid (suspends via JSPI), prints the child's exit code.
#[link(wasm_import_module = "spike")]
extern "C" {
    fn spawn(cmd: *const u8, len: u32) -> i32;
    fn waitpid(pid: i32) -> i32;
}

fn main() {
    let cmd = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let pid = unsafe { spawn(cmd.as_ptr(), cmd.len() as u32) };
    println!("parent: spawned pid {}", pid);
    let code = unsafe { waitpid(pid) };
    println!("parent: child exited with {}", code);
}

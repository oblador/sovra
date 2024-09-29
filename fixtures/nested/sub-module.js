export async function returnTrue() {
  const { returnFalse } = await import("./another-module");
  return !returnFalse();
}

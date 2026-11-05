/** Shared by external imports and exact 10-bit planar uploads. */
export const HDR_SHADER = `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
  let p = array(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0))[index];
  return Vertex(vec4f(p,0.0,1.0), vec2f((p.x+1.0)*0.5,(1.0-p.y)*0.5));
}
fn present_pq(pq: vec3f) -> vec4f {
  let p = pow(clamp(pq,vec3f(0.0),vec3f(1.0)), vec3f(1.0 / 78.84375));
  let nits = pow(max(p - 0.8359375, vec3f(0.0)) / (18.8515625 - 18.6875 * p), vec3f(1.0 / 0.1593017578125)) * 10000.0;
  let p3 = mat3x3f(vec3f(1.343578,-0.065298,0.002822), vec3f(-0.282180,1.075788,-0.019599), vec3f(-0.061398,-0.010490,1.016777)) * (nits / 203.0);
  let a = abs(p3);
  let output = sign(p3) * select(a * 12.92, 1.055 * pow(a,vec3f(1.0/2.4)) - 0.055, a > vec3f(0.0031308));
  return vec4f(output, 1.0);
}`

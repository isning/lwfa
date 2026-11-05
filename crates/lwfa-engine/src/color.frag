#version 100
//_DEFINES_
#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif
precision highp float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif
uniform float alpha;
uniform float source_tf;
uniform float source_primaries;
uniform float source_white;
uniform float source_peak;
uniform float source_black;
uniform float source_target;
uniform float output_mode;
varying vec2 v_coords;
#if defined(DEBUG_FLAGS)
uniform float tint;
#endif
const float m1 = 0.1593017578125;
const float m2 = 78.84375;
const float c1 = 0.8359375;
const float c2 = 18.8515625;
const float c3 = 18.6875;
vec3 decode(vec3 v) {
    // Extended linear scRGB deliberately retains negative components.
    if (source_tf > 2.5 && source_tf < 3.5) return v * (source_peak-source_black);
    v = max(v, vec3(0.0));
    if (source_tf > 3.5) {
        vec3 scene = mix(v*v/3.0, (exp((v-0.55991073)/0.17883277)+0.28466892)/12.0, step(vec3(0.5),v));
        vec3 weights = source_primaries > 1.5 ? vec3(0.2627,0.6780,0.0593) : vec3(0.2126,0.7152,0.0722);
        float gamma = 1.2 + 0.42 * log(source_peak/1000.0)/log(10.0);
        return scene * pow(max(dot(scene,weights),0.0000001),gamma-1.0) * (source_peak-source_black);
    }
    if (source_tf > 1.5) {
        vec3 p = pow(v, vec3(1.0 / m2));
        return pow(max(p - c1, vec3(0.0)) / (c2 - c3 * p), vec3(1.0 / m1)) * 10000.0;
    }
    if (source_tf > 0.5) {
        float b = pow(source_black, 1.0/2.4);
        float w = pow(source_peak, 1.0/2.4);
        return pow(v*(w-b)+b,vec3(2.4))-source_black;
    }
    vec3 low = v / 12.92;
    vec3 high = pow((v + 0.055) / 1.055, vec3(2.4));
    return mix(low, high, step(vec3(0.04045), v)) * (source_peak-source_black);
}
vec3 srgb(vec3 v) {
    v = max(v, vec3(0.0));
    return mix(12.92 * v, 1.055 * pow(v, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), v));
}
void main() {
    vec4 pixel = texture2D(tex, v_coords);
#if defined(NO_ALPHA)
    pixel.a = 1.0;
#endif
    vec3 rgb = pixel.a > 0.0 ? pixel.rgb / pixel.a : vec3(0.0);
    if (output_mode < 0.5) {
        rgb = decode(rgb);
        if (source_primaries > 1.5) {
            rgb = mat3(1.660491,-0.124550,-0.018151, -0.587641,1.132900,-0.100579, -0.072850,-0.008349,1.118730) * rgb;
        } else if (source_primaries > 0.5) {
            rgb = mat3(1.224745,-0.042058,-0.019642, -0.224904,1.042081,-0.078655, 0.0,0.0,1.098537) * rgb;
        }
        // Anchor different viewing environments to the same diffuse white.
        rgb *= 80.0 / (source_white-source_black);
    } else if (output_mode < 1.5) {
        rgb = max(rgb / 80.0, vec3(0.0));
        float y = dot(rgb, vec3(0.2126,0.7152,0.0722));
        float peak = max(source_target / source_white, 1.0);
        if (peak > 1.0 && y > 0.0) rgb *= (1.0 + y/(peak*peak)) / (1.0+y);
        rgb = srgb(clamp(rgb, 0.0, 1.0));
    } else {
        // Linear sRGB at 80-nit reference -> BT.2020/PQ at 203-nit white.
        rgb *= 203.0 / 80.0;
        rgb = mat3(0.627404,0.069097,0.016391, 0.329283,0.919540,0.088013, 0.043313,0.011362,0.895595) * rgb;
        vec3 p = pow(clamp(rgb/10000.0,0.0,1.0), vec3(m1));
        rgb = pow((c1+c2*p)/(1.0+c3*p), vec3(m2));
    }
    gl_FragColor = vec4(rgb * pixel.a, pixel.a) * alpha;
#if defined(DEBUG_FLAGS)
    if (tint == 1.0) gl_FragColor = vec4(0.0,0.2,0.0,0.2) + gl_FragColor*0.8;
#endif
}

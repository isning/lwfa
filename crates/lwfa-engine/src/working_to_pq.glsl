// Shared by packed P010 output and the portable RGB10 resolve.
vec3 working_to_pq(vec3 rgb) {
    // Linear sRGB at 80-nit reference -> BT.2020/PQ at 203-nit white.
    rgb *= 203.0 / 80.0;
    rgb = mat3(0.627404,0.069097,0.016391, 0.329283,0.919540,0.088013, 0.043313,0.011362,0.895595) * rgb;
    vec3 p = pow(clamp(rgb/10000.0,0.0,1.0), vec3(0.1593017578125));
    return pow((0.8359375+18.8515625*p)/(1.0+18.6875*p), vec3(78.84375));
}

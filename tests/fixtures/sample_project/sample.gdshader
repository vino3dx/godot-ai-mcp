shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

uniform vec4 albedo_color : source_color = vec4(1.0, 0.5, 0.2, 1.0);
uniform float roughness_value : hint_range(0.0, 1.0) = 0.4;
uniform float metallic_value : hint_range(0.0, 1.0) = 0.0;
uniform vec2 uv_scale = vec2(1.0, 1.0);
uniform sampler2D detail_tex : hint_default_white;
uniform bool use_detail = false;

void fragment() {
	ALBEDO = albedo_color.rgb;
	ROUGHNESS = roughness_value;
	METALLIC = metallic_value;
}

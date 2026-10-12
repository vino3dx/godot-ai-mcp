extends Node3D
class_name SampleMain

signal ready_for_business(code: int)

@export var speed: float = 1.5
@export var label_text: String = "hello"
@export var tint: Color = Color(1, 0.5, 0.25, 1)
@export var size_2d: Vector2 = Vector2(64, 32)
@export var spawn_offset: Vector3 = Vector3(0, 1, 0)
@export var target_path: NodePath
@export var tags: PackedStringArray = PackedStringArray(["alpha", "beta"])
@export var points: PackedVector3Array = PackedVector3Array([Vector3(1, 2, 3)])
@export var mixed: Array = [1, "two", 3.5, true]
@export var config: Dictionary = {"mode": "demo", "count": 2}

func on_child_hit(damage: int) -> void:
	print("child hit: ", damage)

func emit_sample() -> void:
	ready_for_business.emit(7)

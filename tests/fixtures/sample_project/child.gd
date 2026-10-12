extends Node3D
class_name SampleChild

signal hit(damage: int)

@export var hp: int = 10

func take_damage(amount: int) -> void:
	hp -= amount
	hit.emit(amount)

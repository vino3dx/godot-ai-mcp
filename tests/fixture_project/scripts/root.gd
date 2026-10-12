extends Node2D

# 夹具场景 [connection] 的目标方法:不存在时 Godot 加载会报
# "Cannot connect to method _on_ready"(T6.5 实测发现的夹具缺陷)。
# ready_calls 供 tests/fixtures/t6_verify.gd 断言"持久化的连接真的被建立并触发"。
var ready_calls := 0

func _on_ready() -> void:
	ready_calls += 1
	print("T6RESULT root_on_ready|called")

/**
 * 缓存 Worker 手上那份户型几何，直到换新的为止。
 *
 * 一次运行的消息里大半是几何数据（墙、材质、房间类型、密度图、跨层源掩码），大图上能有几十 MB，
 * 而同一份几何在重启之间、多趟运行之间都不变，所以只发一次、之后按 id 复用。
 * 传错了几何不会报错，只会算出别层的布局，所以对不上 id 就直接拒绝，不勉强作答。
 */
export class GeometryCache<T> {
	private held: { id: string; geometry: T } | null = null;

	/**
	 * 判断一条消息说的是哪份几何。
	 *
	 * `carried` 是随消息带来的几何，收到后它就变成 Worker 手上的那份。没带的话，
	 * 消息必须指明已缓存的那份（`id` 为空表示“你手上那份”，给不跟踪 id 的调用方用），
	 * 而且要声明复用才返回。
	 *
	 * 返回 null 表示消息和这个 Worker 对不上，这时得让调用方知道，不能照样返回。
	 */
	resolve(
		carried: { id: string; geometry: T } | null,
		id: string | undefined,
		reused: boolean | undefined
	): T | null {
		if (carried) {
			this.held = carried;
			return carried.geometry;
		}
		if (!this.held) return null;
		if (id && this.held.id !== id) return null;
		return reused ? this.held.geometry : null;
	}
}

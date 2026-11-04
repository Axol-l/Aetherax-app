<script>
// 应用的实际首页
	import AppShell from '$components/layout/AppShell.svelte';
	import WelcomeDialog from '$lib/components/dialogs/WelcomeDialog.svelte';
</script>

<!-- 主要应用界面、菜单、画布和规划器功能 -->
<AppShell />
<!-- 首次启动显示的欢迎对话框 -->
<WelcomeDialog />

# نظرة عامة على أدوات Claude Code

يوفر Claude Code مجموعة من الأدوات المدمجة للنموذج عبر آلية tool_use في Anthropic API. تحتوي مصفوفة `tools` في كل طلب MainAgent على تعريفات JSON Schema الكاملة لهذه الأدوات، ويستدعيها النموذج في الاستجابة عبر كتل محتوى `tool_use`.

فيما يلي فهرس مصنف لجميع الأدوات.

## نظام الوكلاء

| الأداة | الغرض |
|--------|--------|
| [Agent](Tool-Agent.md) | بدء وكيل فرعي (SubAgent) لمعالجة المهام المعقدة متعددة الخطوات |
| [TaskOutput](Tool-TaskOutput.md) | الحصول على مخرجات المهام الخلفية |
| [TaskStop](Tool-TaskStop.md) | إيقاف مهمة خلفية قيد التشغيل |
| [TaskCreate](Tool-TaskCreate.md) | إنشاء عنصر في قائمة المهام المنظمة |
| [TaskGet](Tool-TaskGet.md) | الحصول على تفاصيل المهمة |
| [TaskUpdate](Tool-TaskUpdate.md) | تحديث حالة المهمة والتبعيات وغيرها |
| [TaskList](Tool-TaskList.md) | عرض جميع المهام |

## الفريق والتنسيق

| الأداة | الغرض |
|--------|--------|
| [TeamCreate](Tool-TeamCreate.md) | إنشاء فريق وكلاء للعمل التعاوني |
| [TeamDelete](Tool-TeamDelete.md) | حل فريق الوكلاء |
| [SendMessage](Tool-SendMessage.md) | إرسال رسالة إلى وكيل آخر |
| [Workflow](Tool-Workflow.md) | تشغيل نص الأتمتة الحتمي متعدد الوكيل |
| [Monitor](Tool-Monitor.md) | دفق الأحداث من برنامج نصي طويل الأجل كإخطارات |

## عمليات الملفات

| الأداة | الغرض |
|--------|--------|
| [Read](Tool-Read.md) | قراءة محتوى الملفات (يدعم النصوص والصور وPDF وJupyter notebook) |
| [Edit](Tool-Edit.md) | تحرير الملفات عبر استبدال نصي دقيق |
| [Write](Tool-Write.md) | كتابة أو الكتابة فوق الملفات |
| [NotebookEdit](Tool-NotebookEdit.md) | تحرير خلايا Jupyter notebook |

## البحث

| الأداة | الغرض |
|--------|--------|
| [Glob](Tool-Glob.md) | البحث عن الملفات بمطابقة أنماط أسماء الملفات |
| [Grep](Tool-Grep.md) | البحث في محتوى الملفات باستخدام ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | البحث وتحميل الأدوات المؤجلة/MCP عند الطلب |

## الطرفية

| الأداة | الغرض |
|--------|--------|
| [Bash](Tool-Bash.md) | تنفيذ أوامر shell |

## الويب

| الأداة | الغرض |
|--------|--------|
| [WebFetch](Tool-WebFetch.md) | جلب محتوى صفحات الويب ومعالجته بالذكاء الاصطناعي |
| [WebSearch](Tool-WebSearch.md) | استعلامات محرك البحث |
| [Artifact](Tool-Artifact.md) | نشر ملف HTML/Markdown كصفحة ويب مستضافة على claude.ai |
| [DesignSync](Tool-DesignSync.md) | مزامنة مكتبة المكونات المحلية مع مشروع claude.ai design-system |

## التخطيط والتفاعل

| الأداة | الغرض |
|--------|--------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | الدخول في وضع التخطيط لتصميم خطة التنفيذ |
| [ExitPlanMode](Tool-ExitPlanMode.md) | الخروج من وضع التخطيط وتقديم الخطة لموافقة المستخدم |
| [AskUserQuestion](Tool-AskUserQuestion.md) | طرح أسئلة على المستخدم للتوضيح أو اتخاذ القرارات |
| [ReportFindings](Tool-ReportFindings.md) | تقرير نتائج فحص الكود كقائمة مكتوبة لواجهة المستخدم |

## أشجار العمل

| الأداة | الغرض |
|--------|--------|
| [EnterWorktree](Tool-EnterWorktree.md) | إنشاء أو إدخال شجرة عمل git معزولة للجلسة |
| [ExitWorktree](Tool-ExitWorktree.md) | الخروج من جلسة شجرة العمل والاحتفاظ بها أو حذفها |

## الجدولة والإشعارات

| الأداة | الغرض |
|--------|--------|
| [CronCreate](Tool-CronCreate.md) | جدولة طلب على تعبير cron (متكرر أو لمرة واحدة) |
| [CronDelete](Tool-CronDelete.md) | إلغاء مهمة cron المجدولة |
| [CronList](Tool-CronList.md) | قائمة مهام cron المجدولة |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | تحديد وتيرة التكرارات /loop بجدولة الاستيقاظ التالي |
| [PushNotification](Tool-PushNotification.md) | إرسال إشعار سطح المكتب/الهاتف المحمول للمستخدم |
| [RemoteTrigger](Tool-RemoteTrigger.md) | إدارة روتين remote-trigger على claude.ai |

## الإضافات

| الأداة | الغرض |
|--------|--------|
| [Skill](Tool-Skill.md) | تنفيذ المهارات (slash command) |

## تكامل IDE

| الأداة | الغرض |
|--------|--------|
| [getDiagnostics](Tool-getDiagnostics.md) | الحصول على معلومات التشخيص اللغوي من VS Code |
| [executeCode](Tool-executeCode.md) | تنفيذ الكود في Jupyter kernel |
| [LSP](Tool-LSP.md) | استعلامات خادم اللغة (التعريفات والمراجع والرموز) |

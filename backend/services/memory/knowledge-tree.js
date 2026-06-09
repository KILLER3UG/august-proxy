const semanticMemory = require('./semantic-memory');
const { upsertEntity, upsertRelation, findEntity, readGraphMemory } = require('./graph-memory');

// ── Canonical prefix-to-project mapping ──
// First matching prefix wins. Order matters (more specific first).
const PREFIX_MAP = [
    { prefix: 'august_proxy_', project: 'august-proxy' },
    { prefix: 'claudish_proxy_', project: 'august-proxy' },
    { prefix: 'dockercontainer_', project: 'august-proxy' },
    { prefix: 'agentic_trading_', project: 'Agentic Trading' },
    { prefix: 'crypto_trading_', project: 'Agentic Trading' },
    { prefix: 'mtp_', project: 'Agentic Trading' },
    { prefix: 'backend_', project: 'CAPS-mobile' },
    { prefix: 'frontend_', project: 'CAPS-mobile' },
    { prefix: 'caps_', project: 'CAPS-mobile' },
    { prefix: 'ec2_', project: 'CAPS-mobile' },
    { prefix: 'aws_', project: 'CAPS-mobile' },
    { prefix: 'production_', project: 'CAPS-mobile' },
    { prefix: 'kimi_', project: 'Research' },
    { prefix: 'gemma_', project: 'Research' },
    { prefix: 'pldt_', project: 'Infrastructure' },
    { prefix: 'isp_', project: 'Infrastructure' },
];

const HIERARCHY_RELATION = 'belongs_to';

// ── Helpers ──

function prefixToProject(key) {
    if (!key) return null;
    const lower = key.toLowerCase();
    for (const entry of PREFIX_MAP) {
        if (lower.startsWith(entry.prefix)) return entry.project;
    }
    return null;
}

function extractSubtopics(key, project) {
    // Strip project prefix
    const lower = key.toLowerCase();
    const projPrefixes = PREFIX_MAP
        .filter(e => e.project === project)
        .map(e => e.prefix);

    let remaining = lower;
    for (const pfx of projPrefixes) {
        if (remaining.startsWith(pfx)) {
            remaining = remaining.slice(pfx.length);
            break;
        }
    }

    // Split remaining by underscore
    const segments = remaining.split('_').filter(s => s.length > 0 && !/^\d{6,}$/.test(s));

    // Map known segment patterns to cleaner group names
    const GROUP_MAP = {
        'deployment': 'Deployment',
        'backend': 'Backend',
        'frontend': 'Frontend',
        'frontendmobile': 'Mobile',
        'mobile': 'Mobile',
        'aws': 'AWS',
        'ec2': 'AWS',
        'pem': 'AWS',
        'ppk': 'AWS',
        'ssh': 'AWS',
        'production': 'AWS',
        'server': 'AWS',
        'remote': 'AWS',
        'api': 'API',
        'analytics': 'Analytics',
        'apk': 'APK Build',
        'notification': 'Notifications',
        'leaderboard': 'Leaderboard',
        'subject': 'Subjects',
        'student': 'Students',
        'faculty': 'Faculty',
        'dean': 'Dean',
        'question': 'Questions',
        'practice': 'Practice Exam',
        'version': 'Versioning',
        'commit': 'Commits',
        'push': 'Push',
        'file': 'Files',
        'config': 'Config',
        'service': 'Services',
        'endpoint': 'Endpoints',
        'test': 'Testing',
        'dark': 'Dark Mode',
        'ui': 'UI',
        'docker': 'Docker',
        'container': 'Containers',
        'phase': 'Phase',
        'mtp': 'MTP',
        'lstm': 'MTP',
        'training': 'Training',
        'model': 'Models',
        'architecture': 'Architecture',
        'repo': 'Repository',
        'github': 'Repository',
        'branch': 'Repository',
        'project': 'Project',
    };

    // Build group segments: take first known group, then rest
    const cleanSegments = [];
    for (const seg of segments) {
        const cleaned = GROUP_MAP[seg] || seg.charAt(0).toUpperCase() + seg.slice(1).replace(/_/g, ' ');
        if (!cleanSegments.includes(cleaned)) {
            cleanSegments.push(cleaned);
        }
    }

    return cleanSegments.slice(0, 3);
}

function getOrCreateNode(name, type = 'topic') {
    return upsertEntity({ name, type, source: 'knowledge-tree', confidence: 0.9 });
}

function attachNode(childName, parentName) {
    if (childName.toLowerCase() === parentName.toLowerCase()) return null;
    const parent = getOrCreateNode(parentName);
    const child = getOrCreateNode(childName);

    const graph = readGraphMemory();
    const exists = graph.relations.find(r =>
        r.from === child.id && r.type === HIERARCHY_RELATION && r.to === parent.id
    );
    if (exists) return { child, parent };

    // Circular check
    const breadcrumb = getBreadcrumb(graph, parent.id);
    if (breadcrumb.some(c => c.toLowerCase() === childName.toLowerCase())) return null;

    upsertRelation({
        from: child.id,
        type: HIERARCHY_RELATION,
        to: parent.id,
        source: 'knowledge-tree',
        confidence: 0.85
    });
    return { child, parent };
}

function getBreadcrumb(graph, entityId) {
    const crumbs = [];
    let current = graph.entities.find(e => e.id === entityId);
    while (current) {
        crumbs.unshift(current.name);
        const relation = graph.relations.find(r => r.type === HIERARCHY_RELATION && r.from === current.id);
        current = relation ? graph.entities.find(e => e.id === relation.to) : null;
    }
    return crumbs;
}

// ── Public API ──

/**
 * Build a tree from semantic facts that match the query.
 * Returns an array of tree branch objects.
 */
function topicTree(query, depth = 4) {
    const maxDepth = Math.max(1, Math.min(8, Number(depth) || 4));
    const facts = semanticMemory.searchFacts(query || '');
    const category = null;

    if (!query || facts.length === 0) {
        return `No matching facts found for "${query}".`;
    }

    // Phase 1: Build tree structure
    // root -> project -> subtopic -> leaf
    const tree = { _name: 'root', _facts: [], _children: {} };

    for (const fact of facts) {
        const project = prefixToProject(fact.key);
        const rootLabel = fact.category === 'session_temp' ? 'Session Notes' :
                          fact.category === 'workflow_rule' ? 'Workflows' :
                          fact.category === 'user_detail' || fact.category === 'user_preference' ? 'User Setup' :
                          (project && fact.category === 'project_info') ? 'Projects' :
                          project || 'Miscellaneous';

        // Ensure root
        if (!tree._children[rootLabel]) {
            tree._children[rootLabel] = { _name: rootLabel, _facts: [], _children: {} };
        }
        const rootNode = tree._children[rootLabel];
        rootNode._facts.push(fact);

        // Flatten: if root label IS the project name, don't repeat it at level 2
        if (rootLabel !== project && project) {
            // Ensure project node under root
            if (!rootNode._children[project]) {
                rootNode._children[project] = { _name: project, _facts: [], _children: {} };
            }
            const projNode = rootNode._children[project];

            // Extract subtopics from key
            const subtopics = extractSubtopics(fact.key, project);
            let current = projNode;
            for (let i = 0; i < subtopics.length && i < maxDepth - 2; i++) {
                const topicName = subtopics[i];
                if (!current._children[topicName]) {
                    current._children[topicName] = { _name: topicName, _facts: [], _children: {} };
                }
                current = current._children[topicName];
            }
            current._facts.push(fact);
        }
    }

    // Phase 2: Render tree
    const lines = [];
    let totalFacts = 0;
    const rootLabels = Object.keys(tree._children).sort();

    function renderBranch(node, indent, isLast, depthLevel, maxRenderDepth) {
        if (depthLevel > maxRenderDepth) return;
        const prefix = depthLevel === 0 ? '' : (isLast ? '└── ' : '├── ');
        const count = node._facts ? node._facts.length : 0;
        const children = Object.keys(node._children).sort();
        const childCount = children.reduce((s, k) => s + (node._children[k]._facts ? node._children[k]._facts.length : 0), 0);

        if (depthLevel >= 0) {
            const label = node._name + (count > 0 ? ` (${count})` : childCount > 0 ? ` (${childCount})` : '');
            lines.push(indent + prefix + label);
        }

        const childKeys = Object.keys(node._children).sort();
        const childIndent = depthLevel === 0 ? '  ' : indent + (isLast ? '   ' : '│  ');

        childKeys.forEach((key, i) => {
            const last = i === childKeys.length - 1;
            renderBranch(node._children[key], childIndent, last, depthLevel + 1, maxRenderDepth);
        });

        totalFacts += count;
    }

    for (let i = 0; i < rootLabels.length; i++) {
        renderBranch(tree._children[rootLabels[i]], '', i === rootLabels.length - 1, 0, maxDepth);
    }

    return [
        `[Knowledge Tree: "${query}"]`,
        `${rootLabels.length} branches, ${facts.length} matching facts (max depth: ${maxDepth})`,
        '',
        ...lines
    ].join('\n');
}

/**
 * Get breadcrumb path for a topic.
 */
function topicParents(name) {
    const graph = readGraphMemory();
    const entity = findEntityByName(graph, name);
    if (!entity) return `Topic "${name}" not found.`;

    const crumbs = getBreadcrumb(graph, entity.id);
    if (crumbs.length <= 1) return `"${name}" is a root topic.`;

    return `Path: ${crumbs.join(' > ')}`;
}

/**
 * Attach a child topic under a parent.
 */
function topicAttach(child, parent, childType = 'topic') {
    if (!child || !parent) return { error: 'Both child and parent are required.' };
    const result = attachNode(child, parent);
    if (!result) return { error: `Cannot attach: circular or duplicate.` };

    const graph = readGraphMemory();
    const entity = graph.entities.find(e => e.id === result.child.id);
    const crumbs = entity ? getBreadcrumb(graph, entity.id) : [child, parent];

    return { status: 'attached', path: crumbs.join(' > ') };
}

function findEntityByName(graph, name) {
    const lower = (name || '').toLowerCase().trim();
    return graph.entities.find(e =>
        e.name.toLowerCase() === lower ||
        e.id === name
    ) || null;
}

/**
 * Auto-index: rebuild tree from ALL semantic facts.
 */
function autoIndexHierarchy() {
    const facts = semanticMemory.getAllFacts();
    let attached = 0;
    let failed = 0;

    // Ensure root categories exist
    const roots = ['Projects', 'Workflows', 'User Setup', 'Session Notes', 'Miscellaneous'];
    for (const root of roots) {
        getOrCreateNode(root, 'root_category');
    }

    // Group facts by project prefix
    const projectNodes = {};
    for (const fact of facts) {
        const project = prefixToProject(fact.key);
        if (project) {
            if (!projectNodes[project]) {
                projectNodes[project] = { count: 0, facts: [] };
            }
            projectNodes[project].count++;
            projectNodes[project].facts.push(fact);
        }
    }

    // Create project nodes and attach under appropriate root
    for (const [project, info] of Object.entries(projectNodes)) {
        const root = 'Projects';
        const projNode = getOrCreateNode(project, 'project');
        const attachResult = attachNode(project, root);
        if (attachResult) attached++;

        // Create subtopic nodes for fact key prefixes
        const subtopicCounts = {};
        for (const fact of info.facts) {
            const subtopics = extractSubtopics(fact.key, project);
            if (subtopics.length > 0) {
                const topic = subtopics[0];
                subtopicCounts[topic] = (subtopicCounts[topic] || 0) + 1;
            }
        }

        for (const [topic, count] of Object.entries(subtopicCounts)) {
            if (count < 2) continue; // only create nodes with 2+ facts
            const topicNode = getOrCreateNode(topic, 'subtopic');
            const attachResult2 = attachNode(topic, project);
            if (attachResult2) attached++;
        }
    }

    // Attach workflow_rule facts under "Workflows"
    const workflowFacts = facts.filter(f => f.category === 'workflow_rule');
    for (const fact of workflowFacts) {
        const subtopics = extractSubtopics(fact.key, null);
        if (subtopics.length > 0) {
            const node = getOrCreateNode(subtopics[0], 'workflow');
            const result = attachNode(subtopics[0], 'Workflows');
            if (result) attached++;
        }
        failed++;
    }
    // Adjust: workflow facts are many, so batch them
    const workflowNode = getOrCreateNode('Workflow Rules', 'root_category');
    const workflowAttach = attachNode('Workflow Rules', 'Workflows');
    if (workflowAttach) attached++;

    // Simple count of workflow facts as observation
    if (workflowFacts.length > 0) {
        const { addObservation } = require('./graph-memory');
        try {
            addObservation({
                entity: 'Workflows',
                text: `${workflowFacts.length} workflow rules indexed.`,
                source: 'knowledge-tree:auto-index',
                confidence: 0.8,
                type: 'root_category'
            });
        } catch (e) { /* ignore */ }
    }

    return {
        status: 'indexed',
        totalFacts: facts.length,
        nodesAttached: attached,
        projectCount: Object.keys(projectNodes).length,
        factsByProject: Object.fromEntries(
            Object.entries(projectNodes).map(([k, v]) => [k, v.count])
        )
    };
}

/**
 * Get tree skeleton for context injection (compact 1-line summary).
 */
function treeSkeleton(maxLines = 6) {
    const facts = semanticMemory.getAllFacts();
    const projectGroups = {};

    for (const fact of facts) {
        const project = prefixToProject(fact.key);
        const category = fact.category;
        const key = project || category;
        if (!projectGroups[key]) projectGroups[key] = { count: 0, label: key };
        projectGroups[key].count++;
    }

    const sorted = Object.values(projectGroups).sort((a, b) => b.count - a.count).slice(0, maxLines);

    if (sorted.length === 0) return 'Knowledge tree: empty.';
    const lines = sorted.map(g => `  - ${g.label}: ${g.count} facts`);
    lines.unshift(`Knowledge tree: ${facts.length} facts across ${sorted.length} branches`);
    return lines.join('\n');
}

module.exports = {
    topicTree,
    topicParents,
    topicAttach,
    autoIndexHierarchy,
    treeSkeleton,
    prefixToProject,
    extractSubtopics
};

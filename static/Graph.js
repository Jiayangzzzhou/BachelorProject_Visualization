let currentData = null;
let beforeData = null;
let afterData = null;
let classIndex = [];
let validityIndex = null;
let currentClass = null;
let currentGraph = 'before';
let collapseMode = false;
let simulation = null;
let svg = null;
let zoomBehavior = null;

// New for subnode management
let fullData = null;
let visibleNodes = new Set();
let expandedNodes = new Set();
let nodeChildren = new Map(); // Map of node -> its children
let nodeParents = new Map(); // Map of node -> its parents
let hiddenNodeCounts = new Map();
let prevNodePos = new Map();

// Color schemes
const colors = {
    valid: '#4caf50',
    invalid: '#ff5252',
    inferred: '#2196f3',
    validLink: '#4caf50',
    invalidLink: '#ff5252',
    inferredLink: '#2196f3'
};

function basicStats(nums) {
    if (!nums || nums.length === 0) return {n: 0};
    let s = 0, mn = Infinity, mx = -Infinity;
    for (const x of nums) {
        s += x;
        if (x < mn) mn = x;
        if (x > mx) mx = x;
    }
    return {n: nums.length, min: mn, max: mx, mean: +(s / nums.length).toFixed(2)};
}

// Initialize the application
document.addEventListener('DOMContentLoaded', function () {
    loadData();
});

// Load all necessary data
async function loadData() {
    try {
        // Load before and after graph data
        const [beforeResponse, afterResponse, classResponse, validityResponse] = await Promise.all([
            fetch('/api/before_graph'),
            fetch('/api/after_graph'),
            fetch('/api/class_index'),
            fetch('/api/validity_index')
        ]);

        beforeData = await beforeResponse.json();
        afterData = await afterResponse.json();

        function fixLinkSourceTarget(data) {
            data.links = data.links.filter(l => l.subject !== l.object);

            data.links = data.links.map(link => ({
                ...link,
                source: link.subject,
                target: link.object
            }));
        }

        fixLinkSourceTarget(beforeData);
        fixLinkSourceTarget(afterData);

        classIndex = await classResponse.json();
        validityIndex = await validityResponse.json();

        console.log('Data loaded successfully');
        console.log('Classes available:', classIndex.length);

        // Initialize UI
        populateClassDropdown();
        recommendClass();

        // Set initial state
        currentData = beforeData;

    } catch (error) {
        showError('Failed to load data. Please check your Flask server.');
    }
}

// Select a class and update the visualization
let initialized = false;

async function selectClass(className) {
    currentClass = className;
    console.log('Selected class:', className);

    const t0 = performance.now();
    let tFetch = 0, tFilter = 0, tRender = 0;

    try {
        // clean up previous state
        const tFetch0 = performance.now();
        const response = await fetch(`/api/class_data`, {cache: 'no-cache'});
        const groupedData = await response.json();
        tFetch = performance.now() - tFetch0;

        if (!groupedData || !groupedData[className]) {
            showError(`Class ${className} not found in data`);
            return;
        }

        const classData = groupedData[className];

        //filter data for the selected class
        const tFilter0 = performance.now();
        if (currentGraph === 'before') {
            fullData = filterDataForClass(beforeData, classData);
        } else {
            fullData = filterDataForClass(afterData, classData);
        }
        tFilter = performance.now() - tFilter0;

        // initialize subnode management
        initializeSubnodeManagement();

        // render visualization
        const tRender0 = performance.now();
        if (!initialized) {
            initializeVisualization();
            initialized = true;
        } else {
            updateVisualization();
        }

        await new Promise(requestAnimationFrame);
        tRender = performance.now() - tRender0;

        const tTotal = performance.now() - t0;
        const nodesCount = fullData?.nodes?.length || 0;
        const linksCount = fullData?.links?.length || 0;

        if (typeof logClassLoadConsole === 'function') {
            logClassLoadConsole({
                className,
                nodes: nodesCount,
                links: linksCount,
                tFetch, tFilter, tRender, tTotal
            });
        } else {
            const mem = (performance && performance.memory)
                ? {
                    usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
                    totalMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
                    limitMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)
                }
                : null;

            console.groupCollapsed(`📊 Class "${className}" loaded`);
            console.log(`Nodes: ${nodesCount} | Links: ${linksCount}`);
            console.log(`fetch_ms=${tFetch.toFixed(1)} filter_ms=${tFilter.toFixed(1)} render_ms=${tRender.toFixed(1)} total_ms=${tTotal.toFixed(1)}`);
            if (mem) {
                console.log(`Memory used: ${mem.usedMB} MB  (heap total ~${mem.totalMB} MB, limit ~${mem.limitMB} MB)`);
            } else {
                console.log('Memory: N/A (performance.memory unavailable; 可在 chrome://flags 开启 precise memory)');
            }
            console.groupEnd();
        }

    } catch (error) {
        console.error('Error loading class data:', error);
        showError('Failed to load class data');
    }
}

// Initialize subnode management system
function initializeSubnodeManagement() {
    if (!fullData) return;

    // Reset state
    visibleNodes.clear();
    expandedNodes.clear();
    nodeChildren.clear();
    nodeParents.clear();
    hiddenNodeCounts.clear();

    // Build parent-child relationships from links
    fullData.links.forEach(link => {
        const parentId = link.source;
        const childId = link.target;

        // Add child to parent's children list
        if (!nodeChildren.has(parentId)) {
            nodeChildren.set(parentId, new Set());
        }
        nodeChildren.get(parentId).add(childId);

        // Add parent to child's parents list
        if (!nodeParents.has(childId)) {
            nodeParents.set(childId, new Set());
        }
        nodeParents.get(childId).add(parentId);
    });

    // Determine initial visible nodes
    const totalNodes = fullData.nodes.length;

    if (!collapseMode) {
        fullData.nodes.forEach(node => visibleNodes.add(node.id));
        fullData.nodes.forEach(node => expandedNodes.add(node.id));
        hiddenNodeCounts.clear();
    } else if (totalNodes <= 20) {
        fullData.nodes.forEach(node => visibleNodes.add(node.id));
        fullData.nodes.forEach(node => expandedNodes.add(node.id));
    } else {

        // Show only root nodes and nodes with high connectivity initially
        const nodeConnectivity = new Map();

        // Calculate connectivity (number of connections)
        fullData.nodes.forEach(node => {
            const children = nodeChildren.get(node.id) || new Set();
            const parents = nodeParents.get(node.id) || new Set();
            nodeConnectivity.set(node.id, children.size + parents.size);
        });

        // Sort nodes by connectivity and show top nodes
        const sortedNodes = fullData.nodes.sort((a, b) =>
            (nodeConnectivity.get(b.id) || 0) - (nodeConnectivity.get(a.id) || 0)
        );

        // Show top 50 most connected nodes plus some random ones
        const initialNodeCount = Math.min(50, Math.floor(totalNodes * 0.3));
        for (let i = 0; i < initialNodeCount; i++) {
            if (sortedNodes[i]) {
                visibleNodes.add(sortedNodes[i].id);
            }
        }

        // Calculate hidden children counts
        fullData.nodes.forEach(node => {
            const children = nodeChildren.get(node.id) || new Set();
            const hiddenChildren = [...children].filter(childId => !visibleNodes.has(childId));
            if (hiddenChildren.length > 0) {
                hiddenNodeCounts.set(node.id, hiddenChildren.length);
            }
        });
    }

    // Update currentData based on visible nodes
    updateCurrentDataFromVisible();
}

// Update currentData to show only visible nodes and their connections
function updateCurrentDataFromVisible() {
    if (!fullData) return;

    const visibleNodesArray = fullData.nodes.filter(node => visibleNodes.has(node.id));
    const nodeMap = new Map(visibleNodesArray.map(n => [n.id, n]));

    const visibleLinks = fullData.links
        .filter(link =>
            visibleNodes.has(link.source) &&
            visibleNodes.has(link.target) &&
            nodeMap.has(link.source) &&
            nodeMap.has(link.target)
        )
        .map(link => ({
            ...link,
            source: nodeMap.get(link.source),
            target: nodeMap.get(link.target)
        }));

    currentData = {nodes: visibleNodesArray, links: visibleLinks};
}


// Add this helper function somewhere accessible, e.g., after updateCurrentDataFromVisible
function recalculateHiddenNodeCounts() {
    hiddenNodeCounts.clear();
    if (!fullData) return;

    fullData.nodes.forEach(node => {
        if (visibleNodes.has(node.id)) {
            const children = nodeChildren.get(node.id) || new Set();
            const hiddenChildren = [...children].filter(childId => !visibleNodes.has(childId));
            if (hiddenChildren.length > 0) {
                hiddenNodeCounts.set(node.id, hiddenChildren.length);
            }
        }
    });
}

// Handle node click for collapse/expand
function handleNodeClick(event, clickedNode) {
    if (event && event.defaultPrevented) return;
    if (event) event.stopPropagation();

    if (!collapseMode) {
        showNotification('It is "Show All Nodes" mode, cannot collapse/expand nodes');
        return;
    }

    const nodeId = clickedNode.id;
    const children = nodeChildren.get(nodeId) || new Set();

    if (children.size === 0) return;

    if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);

        const hideSet = new Set();
        const q = [];

        // check if child should be hidden based on other visible parents
        function shouldHideFrom(parentId, childId) {
            const parents = nodeParents.get(childId) || new Set();
            for (const p of parents) {
                // only consider other visible parents that are not already in hideSet
                if (p !== parentId && visibleNodes.has(p) && !hideSet.has(p)) return false;
            }
            return true;
        }

        // first layer: direct children
        for (const cId of children) {
            if (visibleNodes.has(cId) && shouldHideFrom(nodeId, cId)) {
                hideSet.add(cId);
                q.push(cId);
            }
        }

        // recursively check grandchildren
        while (q.length) {
            const cur = q.shift();
            const grand = nodeChildren.get(cur) || new Set();
            for (const gId of grand) {
                if (!visibleNodes.has(gId)) continue;

                // gId wheather can be hidden depends on all its parents
                const parents = nodeParents.get(gId) || new Set();
                let hasOtherVisibleParent = false;
                for (const p of parents) {
                    if (!hideSet.has(p) && visibleNodes.has(p)) {
                        hasOtherVisibleParent = true;
                        break;
                    }
                }
                if (!hasOtherVisibleParent && !hideSet.has(gId)) {
                    hideSet.add(gId);
                    q.push(gId);
                }
            }
        }

        for (const id of hideSet) {
            visibleNodes.delete(id);
            expandedNodes.delete(id);
        }
        showNotification(`Collapsed: ${clickedNode.label || nodeId}`);

    } else {
        const toShow = new Set();
        const q = [...children];
        let head = 0;

        // recursively add all descendants
        while (head < q.length) {
            const cId = q[head++];
            if (!visibleNodes.has(cId)) toShow.add(cId);
            const grand = nodeChildren.get(cId) || new Set();
            for (const gId of grand) {
                if (!visibleNodes.has(gId)) q.push(gId);
            }
        }

        for (const id of toShow) visibleNodes.add(id);
        expandedNodes.add(nodeId);

        showNotification(`Expanded: ${clickedNode.label || nodeId}`);
    }

    updateCurrentDataFromVisible();
    recalculateHiddenNodeCounts();
    updateVisualization();
}


// Populate the class dropdown
function populateClassDropdown() {
    const dropdown = document.getElementById('classDropdown');
    dropdown.innerHTML = '<option value="">Select a class...</option>';

    classIndex.forEach(className => {
        const option = document.createElement('option');
        option.value = className;
        option.textContent = className;
        dropdown.appendChild(option);
    });

    dropdown.addEventListener('change', function () {
        if (this.value) {
            selectClass(this.value);
        } else {
            showAllClasses();
        }
    });
}

// Recommend interesting classes based on validation results
function recommendClass() {
    fetch('/api/class_data')
        .then(res => res.json())
        .then(groupedData => {
            let bestClass = null;
            let bestScore = -1;

            Object.entries(groupedData).forEach(([className, classInfo]) => {
                const before = filterDataForClass(beforeData, classInfo);
                const after = filterDataForClass(afterData, classInfo);

                const beforeNodeIds = new Set(before.nodes.map(n => n.id));
                const afterNodeIds = new Set(after.nodes.map(n => n.id));

                const beforeLinkSet = new Set(before.links.map(l => `${l.subject}|${l.predicate}|${l.object}`));
                const afterLinkSet = new Set(after.links.map(l => `${l.subject}|${l.predicate}|${l.object}`));

                // Differences after reasoning
                const addedNodes = [...afterNodeIds].filter(id => !beforeNodeIds.has(id));
                const addedLinks = [...afterLinkSet].filter(key => !beforeLinkSet.has(key));
                const commonNodes = [...afterNodeIds].filter(id => beforeNodeIds.has(id));

                const totalNodeCount = after.nodes.length;
                if (totalNodeCount < 10 || totalNodeCount > 2000) return;

                // prioritize changes + stable size
                const score =
                    addedNodes.length * 2 +
                    addedLinks.length +
                    commonNodes.length * 0.2;

                if (score > bestScore) {
                    bestScore = score;
                    bestClass = className;
                }
            });

            if (bestClass) {
                document.getElementById('classDropdown').value = bestClass;
                selectClass(bestClass);
                showNotification(`Recommended class: ${bestClass} (score: ${bestScore.toFixed(2)})`);
            } else {
                showNotification('No suitable class found.');
            }
        })
        .catch(err => {
            console.error('Error recommending class:', err);
            showNotification('Failed to recommend class');
        });
}

// Filter data for a specific class
function filterDataForClass(originalData, classData) {
    const classNodeIds = new Set(classData.nodes.map(n => n.id));
    const includedNodeIds = new Set();
    const filteredNodes = [];
    const relatedLinks = [];

    //add all nodes that are explicitly part of the selected class
    classData.nodes.forEach(node => { // Use classData.nodes directly here
        if (!includedNodeIds.has(node.id)) {
            filteredNodes.push(originalData.nodes.find(n => n.id === node.id)); // Find the full node object from originalData
            includedNodeIds.add(node.id);
        }
    });

    // find all links involving any of the class nodes, or any nodes linked to class nodes
    originalData.links.forEach(link => {
        const sourceIsClassNode = classNodeIds.has(link.subject);
        const targetIsClassNode = classNodeIds.has(link.object);

        if (sourceIsClassNode || targetIsClassNode) {
            relatedLinks.push({
                ...link,
                source: link.subject,
                target: link.object
            });

            // Add the subject node if not already included
            if (!includedNodeIds.has(link.subject)) {
                const subjectNode = originalData.nodes.find(n => n.id === link.subject);
                if (subjectNode) {
                    filteredNodes.push(subjectNode);
                    includedNodeIds.add(link.subject);
                }
            }
            // Add the object node if not already included
            if (!includedNodeIds.has(link.object)) {
                const objectNode = originalData.nodes.find(n => n.id === link.object);
                if (objectNode) {
                    filteredNodes.push(objectNode);
                    includedNodeIds.add(link.object);
                }
            }
        }
    });

    return {
        nodes: filteredNodes.filter(Boolean), // Filter out any undefined if find returns nothing
        links: relatedLinks
    };
}

// Show all classes (reset filter)
function showAllClasses() {
    currentClass = null;
    fullData = currentGraph === 'before' ? beforeData : afterData;
    visibleNodes.clear();
    expandedNodes.clear();

    // Populate visibleNodes with ALL node IDs from fullData
    if (fullData && fullData.nodes) {
        fullData.nodes.forEach(node => {
            visibleNodes.add(node.id);
            expandedNodes.add(node.id);
        });
    }

    recalculateHiddenNodeCounts();
    updateCurrentDataFromVisible();
    updateVisualization();
}

// Initialize the visualization
function initializeVisualization() {
    svg = d3.select('#viz')
        .attr('width', '100%')
        .attr('height', '100%');

    // define arrowhead marker
    svg.append("defs").append("marker")
        .attr("id", "arrowhead")
        .attr("viewBox", "-0 -5 10 10")
        .attr("refX", 20)
        .attr("refY", 0)
        .attr("orient", "auto")
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("xoverflow", "visible")
        .append("svg:path")
        .attr("d", "M 0,-5 L 10,0 L 0,5")
        .attr("fill", "#aaa9a9")
        .style("stroke", "none");

    const root = svg.append('g').attr('class', 'graph-content');
    root.append('g').attr('class', 'links');
    root.append('g').attr('class', 'edge-labels');
    root.append('g').attr('class', 'nodes');

    let NODE_LABEL_MIN_K = 0.6;
    let EDGE_LABEL_MIN_K = 1.1;


    zoomBehavior = d3.zoom()
        .scaleExtent([0.1, 10])
        .on('zoom', function (event) {
            root.attr('transform', event.transform);
            const k = event.transform.k;
            root.select('.edge-labels').attr('display', k > EDGE_LABEL_MIN_K ? null : 'none');
            root.selectAll('.nodes text').attr('display', k > NODE_LABEL_MIN_K ? null : 'none');
        });

    svg.call(zoomBehavior);
    updateVisualization();
}


// Update the visualization with current data
function updateVisualization() {
    if (!currentData) return;
    console.time('updateVisualization');
    // SVG & layers
    const root = svg.select('.graph-content');
    const linkLayer = root.select('.links').empty() ? root.append('g').attr('class', 'links') : root.select('.links');
    const edgeTextLayer = root.select('.edge-labels').empty() ? root.append('g').attr('class', 'edge-labels') : root.select('.edge-labels');
    const nodeLayer = root.select('.nodes').empty() ? root.append('g').attr('class', 'nodes') : root.select('.nodes');

    const box = svg.node().getBoundingClientRect();
    const width = box.width, height = box.height;

    // warm start（
    if (typeof prevNodePos !== 'undefined' && prevNodePos instanceof Map) {
        currentData.nodes.forEach(n => {
            const prev = prevNodePos.get(n.id);
            if (prev) {
                n.x = prev.x;
                n.y = prev.y;
                n.vx = prev.vx || 0;
                n.vy = prev.vy || 0;
            }
        });
    }

    // call degree before creating new simulation
    const deg = new Map();
    currentData.links.forEach(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        deg.set(s, (deg.get(s) || 0) + 1);
        deg.set(t, (deg.get(t) || 0) + 1);
    });

    const degrees = Array.from(deg.values());

    const hasChildrenMap = new Map();
    currentData.nodes.forEach(n => {
        const c = (nodeChildren.get(n.id) || new Set());
        hasChildrenMap.set(n.id, c.size > 0);
    });

    // LINKS
    const linkKey = (d, i) => {
        const s = typeof d.source === 'object' ? d.source.id : d.source;
        const t = typeof d.target === 'object' ? d.target.id : d.target;
        const pred = d.predicate ?? d.label ?? '';
        return d.id ? `id:${d.id}` : `${s}|${t}|${pred}|${i}`;
    };

    let linkSel = linkLayer.selectAll('line.link')
        .data(currentData.links, linkKey);

    linkSel.exit().transition().duration(200).style('opacity', 0).remove();

    const linkEnter = linkSel.enter().append('line')
        .attr('class', 'link')
        .style('opacity', 0)
        .style('stroke', d => getLinkColor(d))
        .style('stroke-width', d => d.inferred ? 2 : 2)
        .style('stroke-dasharray', d => d.inferred ? '5,5' : 'none')
        .attr('marker-end', 'url(#arrowhead)');

    linkSel = linkEnter.merge(linkSel)
        .transition().duration(200)
        .style('opacity', 1)
        .selection();

    // EDGE LABELS
    let eLabelSel = edgeTextLayer.selectAll('text.edge-label')
        .data(currentData.links, linkKey);

    eLabelSel.exit().transition().duration(100).style('opacity', 0).remove();

    const eLabelEnter = eLabelSel.enter().append('text')
        .attr('class', 'edge-label')
        .attr('dy', -2)
        .style('font-size', '10px')
        .style('fill', '#666')
        .style('opacity', 0)
        .text(d => getPredicateLabel(d.predicate));

    eLabelSel = eLabelEnter.merge(eLabelSel)
        .transition().duration(200)
        .style('opacity', 1)
        .selection();

    // NODES
    let nodeSel = nodeLayer.selectAll('g.node')
        .data(currentData.nodes, d => d.id);

    nodeSel.exit().transition().duration(200).style('opacity', 0).remove();

    const nodeEnter = nodeSel.enter().append('g')
        .attr('class', 'node')
        .style('opacity', 0);

    nodeEnter.on('click', (event, node) => {
        if (!collapseMode) return;
        if (!hasChildrenMap.get(node.id)) return;
        handleNodeClick(event, node);
    });

    // DRAG
    nodeEnter.call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));

    // Outer circle for collapse indicator
    nodeEnter.append('circle')
        .attr('class', 'outer-circle')
        .attr('r', node => (hiddenNodeCounts.get(node.id) > 0 ? getNodeSize(node) + 8 : 0))
        .style('fill', 'none')
        .style('stroke', '#ff9800')
        .style('stroke-width', 2)
        .style('stroke-dasharray', '3,3')
        .style('opacity', node => hiddenNodeCounts.get(node.id) > 0 ? 0.7 : 0);

    // Main circle
    nodeEnter.append('circle')
        .attr('class', 'main-circle')
        .attr('r', node => getNodeSize(node))
        .style('fill', node => getNodeColor(node))
        .style('stroke', '#fff')
        .style('stroke-width', 2);

    // node count badge
    nodeEnter.append('circle')
        .attr('class', 'count-badge')
        .attr('cx', node => getNodeSize(node) + 5)
        .attr('cy', node => -getNodeSize(node) - 5)
        .attr('r', 8)
        .style('fill', '#ff9800')
        .style('stroke', '#fff')
        .style('stroke-width', 1)
        .style('opacity', node => (collapseMode && (hiddenNodeCounts.get(node.id) > 0)) ? 1 : 0);

    // badge text
    nodeEnter.append('text')
        .attr('class', 'count-text')
        .attr('x', node => getNodeSize(node) + 5)
        .attr('y', node => -getNodeSize(node) - 5)
        .attr('dy', '.35em')
        .attr('text-anchor', 'middle')
        .text(node => hiddenNodeCounts.get(node.id) || '')
        .style('font-size', '10px')
        .style('font-weight', 'bold')
        .style('fill', '#fff')
        .style('opacity', node => (collapseMode && (hiddenNodeCounts.get(node.id) > 0)) ? 1 : 0);

    // label
    nodeEnter.append('text')
        .attr('dx', 12)
        .attr('dy', '.35em')
        .text(node => node.label || node.id)
        .style('font-size', '12px')
        .style('fill', '#333');

    // tooltip
    nodeEnter.append('title').text(node => {
        const hiddenCount = hiddenNodeCounts.get(node.id) || 0;
        const expanded = expandedNodes.has(node.id);
        const hasChildren = hasChildrenMap.get(node.id);
        let tip = `${node.label || node.id}\nType: ${node.type}\nStatus: ${node.status}`;
        if (hasChildren && collapseMode) {
            tip += `\nClick nodes with orange dashed circles to ${expanded ? 'collapse' : 'expand'} subnodes`;
        }
        if (hiddenCount > 0) tip += `\nHidden children: ${hiddenCount}`;
        return tip;
    });

    nodeSel = nodeEnter.merge(nodeSel);

    // update all nodes
    nodeSel.select('circle.outer-circle')
        .attr('r', node => (hiddenNodeCounts.get(node.id) > 0 ? getNodeSize(node) + 8 : 0))
        .style('opacity', node => hiddenNodeCounts.get(node.id) > 0 ? 0.7 : 0);

    nodeSel.select('circle.main-circle')
        .attr('r', node => getNodeSize(node))
        .style('fill', node => getNodeColor(node));

    nodeSel.select('circle.count-badge')
        .attr('cx', node => getNodeSize(node) + 5)
        .attr('cy', node => -getNodeSize(node) - 5)
        .style('opacity', node => (collapseMode && (hiddenNodeCounts.get(node.id) > 0)) ? 1 : 0);

    nodeSel.select('text.count-text')
        .attr('x', node => getNodeSize(node) + 5)
        .attr('y', node => -getNodeSize(node) - 5)
        .text(node => hiddenNodeCounts.get(node.id) || '')
        .style('opacity', node => (collapseMode && (hiddenNodeCounts.get(node.id) > 0)) ? 1 : 0);

    nodeSel
        .style('cursor', node => (collapseMode && hasChildrenMap.get(node.id)) ? 'pointer' : 'default')
        .transition().duration(200).style('opacity', 1);

    // SIMULATION
    if (!simulation) {
        simulation = d3.forceSimulation()
            .alphaDecay(0.03) //  0.05 for Large; 0.07–0.09 for Huge
            .velocityDecay(0.2) //  0.4 for Large; 0.5 for Huge
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('x', d3.forceX(width / 2).strength(0.02))
            .force('y', d3.forceY(height / 2).strength(0.02));
    } else {
        simulation
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('x', d3.forceX(width / 2).strength(0.02))
            .force('y', d3.forceY(height / 2).strength(0.02));
    }

    const linkForce = d3.forceLink(currentData.links)
        .id(d => d.id)
        .distance(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return 60 + 18 * Math.min(deg.get(s) || 0, deg.get(t) || 0);
        })
        .strength(0.5);

    const chargeForce = d3.forceManyBody()
        .strength(n => {
            const d = deg.get(n.id) || 0;
            return -120 - Math.min(12 * d, 240);
        })
        .distanceMin(10)
        .distanceMax(600);

    const collideForce = d3.forceCollide()
        .radius(n => (getNodeSize(n) || 12) + 6);

    simulation
        .nodes(currentData.nodes)
        .force('link', linkForce)
        .force('charge', chargeForce)
        .force('collision', collideForce)
        .alpha(0.8)
        .restart();

    simulation.on('tick', () => {
        linkSel
            .attr('x1', l => l.source.x)
            .attr('y1', l => l.source.y)
            .attr('x2', l => l.target.x)
            .attr('y2', l => l.target.y);

        eLabelSel
            .attr('x', l => (l.source.x + l.target.x) / 2)
            .attr('y', l => (l.source.y + l.target.y) / 2);

        nodeSel.attr('transform', n => `translate(${n.x},${n.y})`);
    });

    if (typeof prevNodePos !== 'undefined' && prevNodePos instanceof Map) {
        clearTimeout(updateVisualization._snapTimer);
        updateVisualization._snapTimer = setTimeout(() => {
            prevNodePos.clear();
            currentData.nodes.forEach(n => {
                prevNodePos.set(n.id, {x: n.x, y: n.y, vx: n.vx, vy: n.vy});
            });
        }, 600);
    }
    console.timeEnd('updateVisualization');
}


// Helper functions
function getNodeColor(node) {
    if (node.status === 'invalid') return colors.invalid;
    if (node.status === 'valid') return colors.valid;
    if (node.status === 'inferred') return colors.inferred;
    return '#999';
}

function getLinkColor(link) {
    if (link.status === 'invalid' && link.inferred) return colors.invalidLink;
    if (link.status === 'valid' && link.inferred) return colors.validLink;
    if (link.inferred && !link.status) return colors.inferredLink;
    if (link.status === 'invalid') return colors.invalidLink;
    if (link.status === 'valid') return colors.validLink;
    return '#999';
}

function getNodeSize(node) {
    return node.type === 'BNode' ? 8 : 12;
}

function getPredicateLabel(predicate) {
    const parts = predicate.split(/[/#]/);
    return parts[parts.length - 1];
}

// Switch between before/after graphs
function switchGraph() {
    if (!currentClass) {
        showError("Please select a class first.");
        return;
    }
    currentGraph = currentGraph === 'before' ? 'after' : 'before';

    const switchText = document.getElementById('switch-text');
    switchText.textContent = currentGraph === 'before'
        ? 'Show After Reasoning'
        : 'Show Before Reasoning';

    selectClass(currentClass);
}

function toggleCollapseMode() {
    collapseMode = !collapseMode;

    if (!currentClass) {
        showError("Please select a class first.");
        return;
    }

    const btn = document.getElementById('collapse-toggle-text');
    btn.textContent = collapseMode ? 'Show All Nodes' : 'Enable Collapse Mode';

    initializeSubnodeManagement();
    updateVisualization();

    const nodes = d3.select('.graph-content').select('.nodes').selectAll('g.node');
    nodes.style('cursor', collapseMode ? 'pointer' : 'default');
}

// Zoom controls
function zoomIn() {
    svg.transition().call(
        zoomBehavior.scaleBy, 1.5
    );
}

function zoomOut() {
    svg.transition().call(
        zoomBehavior.scaleBy, 1 / 1.5
    );
}

function resetZoom() {
    svg.transition().call(
        zoomBehavior.transform,
        d3.zoomIdentity
    );
}

// Drag functions
function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
}

function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
}

function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
}

// Utility functions
function showNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4caf50;
        color: white;
        padding: 15px 20px;
        border-radius: 5px;
        z-index: 1000;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        document.body.removeChild(notification);
    }, 3000);
}

function showError(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff5252;
        color: white;
        padding: 15px 20px;
        border-radius: 5px;
        z-index: 1000;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        document.body.removeChild(notification);
    }, 5000);
}

function toggleValidationReport() {
    const panel = document.getElementById('validation-report');
    const opening = panel.style.display === 'none';
    if (panel.style.display === 'none') {
        updateValidationReport();
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

function updateValidationReport() {
    if (!currentData || !currentClass) {
        document.getElementById('validation-report-content').innerText = "Please select a class.";
        return;
    }

    const allNodes = fullData?.nodes || [];
    const allLinks = fullData?.links || [];
    console.log('[REPORT] fullData nodes:', allNodes.length);
    console.log('[REPORT] fullData links:', allLinks.length);


    let invalidNodeCount = 0;
    let inferredNodeCount = 0;

    let invalidLinkCount = 0;
    let inferredLinkCount = 0;

    allNodes.forEach(n => {
        if (n.status === 'invalid') invalidNodeCount++;
        if (n.inferred) inferredNodeCount++;
    });

    allLinks.forEach(l => {
        if (l.status === 'invalid') invalidLinkCount++;
        if (l.inferred) inferredLinkCount++;
    });

    // Add information about hidden nodes
    const totalNodes = fullData ? fullData.nodes.length : allNodes.length;

    document.getElementById('validation-report-content').innerHTML = `
        <div><strong>Class:</strong> ${currentClass}</div>
        
        <div><strong>Mode:</strong> ${currentGraph === 'before' ? 'Before Reasoning' : 'After Reasoning'}</div>
        <div style="margin-top: 8px;">Nodes: ${totalNodes} total<br>
             ${invalidNodeCount} invalid<br>
             ${inferredNodeCount} inferred</div>
        <div style="margin-top: 8px;">Links: ${allLinks.length} total<br>
             ${invalidLinkCount} invalid<br>
             ${inferredLinkCount} inferred</div>
        </div>
    `;

    // close the panel if clicked outside
    document.addEventListener('click', function closePanelIfOutside(event) {
        const panel = document.getElementById('validation-report');
        const button = document.querySelector('.zoom-btn[onclick="toggleValidationReport()"]');
        if (panel && panel.style.display !== 'none') {
            const isInsidePanel = panel.contains(event.target);
            const isButton = button.contains(event.target);
            if (!isInsidePanel && !isButton) {
                panel.style.display = 'none';
                document.removeEventListener('click', closePanelIfOutside);
            }
        }
    });

}
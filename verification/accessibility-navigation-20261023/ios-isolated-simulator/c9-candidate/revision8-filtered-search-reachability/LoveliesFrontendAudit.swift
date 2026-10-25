import XCTest

/// Local QA runner for the installed Lovelies DEBUG reference gallery only.
/// It never chooses Return to connected app, a provider, a camera or a send action.
final class LoveliesFrontendAudit: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.lovelies.memories")
    private let galleryLabel = "Close preview and open screen gallery"
    private let largestType = "UICTContentSizeCategoryAccessibilityXXXL"
    private var rows = [[String: Any]]()

    override func setUpWithError() throws {
        continueAfterFailure = false
        executionTimeAllowance = 2400
    }

    private func launch(large: Bool = false) throws {
        app.launchArguments = ["--reference-preview"]
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", largestType] }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        let notice = app.alerts["Lovelies reference review"]
        if notice.waitForExistence(timeout: 3) { notice.buttons["Explore the screens"].tap() }
        XCTAssertTrue(app.buttons[galleryLabel].waitForExistence(timeout: 8), "Reference mode must be explicit before any UI action")
    }

    private func choose(_ screen: Int) throws {
        let gallery = app.buttons[galleryLabel]
        XCTAssertTrue(gallery.waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(gallery.isHittable, "The gallery control is obscured; clear external overlays before continuing")
        gallery.tap()
        XCTAssertTrue(app.navigationBars["Screen gallery"].waitForExistence(timeout: 5), "The gallery did not open; inspect external overlays before diagnosing its search")
        var search = app.searchFields.firstMatch
        if !search.waitForExistence(timeout: 3), app.buttons["Search"].exists {
            app.buttons["Search"].tap()
            search = app.searchFields.firstMatch
        }
        XCTAssertTrue(search.waitForExistence(timeout: 5), "Screen gallery search is missing")
        search.tap()
        if let value = search.value as? String, value != "Find a screen", !value.isEmpty {
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        search.typeText(String(screen))
        let prefix = String(format: "%02d", screen)
        let cell = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 5), "Missing gallery screen \(screen)")
        cell.tap()
        XCTAssertTrue(app.staticTexts["Preview · \(screen) of 48"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
    }

    private func rect(_ frame: CGRect) -> [Double] {
        let values = [Double(frame.minX), Double(frame.minY), Double(frame.maxX), Double(frame.maxY)]
        return values.allSatisfy(\.isFinite) ? values : []
    }

    private func capture(_ name: String) {
        guard app.state == .runningForeground, app.buttons[galleryLabel].exists else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachJSON(_ object: Any, name: String) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func actions(in container: XCUIElement? = nil, viewport: CGRect? = nil, photoViewport: CGRect? = nil) -> [[String: Any]] {
        let window = (viewport ?? app.frame).intersection(app.frame)
        let scope = container ?? app
        let elements = scope.buttons.allElementsBoundByIndex + scope.switches.allElementsBoundByIndex + scope.textFields.allElementsBoundByIndex + scope.textViews.allElementsBoundByIndex
        return elements.map { element in
            let label = element.label
            let frame = element.frame
            let effectiveWindow = isPhotoAction(label) ? (photoViewport ?? window).intersection(window) : window
            let intersection = frame.intersection(effectiveWindow)
            let onScreen = !intersection.isNull && !intersection.isEmpty
            var row: [String: Any] = ["label": label, "identifier": element.identifier,
                                     "type": element.elementType.rawValue, "frame": rect(frame),
                                     "intersection": intersection.isNull ? [] : rect(intersection),
                                     "hittable": NSNull(), "hittability_queried": onScreen,
                                     "enabled": element.isEnabled, "selected": element.isSelected,
                                     "value": String(describing: element.value ?? "")]
            // XCTest can fail while resolving an activation point for a node
            // wholly outside the window. Retain its geometry and unknown result;
            // scrolling must expose it before it can count as a reachable action.
            if onScreen { row["hittable"] = element.isHittable }
            else { row["hittability_not_queried_reason"] = photoViewport != nil && isPhotoAction(label) ? "No verified grid viewport intersection" : "No visible window intersection" }
            if photoViewport != nil && isPhotoAction(label) { row["photo_visibility_scope"] = rect(effectiveWindow) }
            return row
        }
    }

    private func signature() -> String {
        // One coherent hierarchy request, rather than a separate IPC query for
        // each property of every descendant. Discard only debug object addresses.
        app.debugDescription.replacingOccurrences(of: "0x[0-9a-fA-F]+", with: "", options: .regularExpression)
    }

    private func audit(phase: String) throws -> [[String: Any]] {
        var issues = [[String: Any]]()
        try app.performAccessibilityAudit(for: .all) { issue in
            var row: [String: Any] = ["phase": phase, "type": issue.auditType.rawValue,
                                      "description": issue.compactDescription, "detail": issue.detailedDescription]
            if let element = issue.element {
                row["label"] = element.label; row["frame"] = self.rect(element.frame)
            }
            // Bind this issue's current geometry to its own native pixels, including anonymous issues.
            // A pre-audit scroll screenshot may no longer match the audit's final viewport.
            let image = XCTAttachment(screenshot: self.app.screenshot())
            image.name = "native-issue-\(phase)-\(UUID().uuidString)"
            image.lifetime = .keepAlways
            self.add(image)
            row["native_issue_screenshot"] = image.name
            issues.append(row)
            return true // Collect every issue; the matrix fails explicitly below if any were found.
        }
        return issues
    }


    private struct ScrollMark {
        let label: String
        let ordinal: Int
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
        var row: [String: Any] {
            ["label": label, "ordinal": ordinal, "relative_x": Double(x), "relative_y": Double(y),
             "width": Double(width), "height": Double(height)]
        }
    }

    private struct GridSurface {
        let element: XCUIElement
        let ordinal: Int
        let viewport: CGRect
        let evidence: [String: Any]
    }

    private func isPhotoAction(_ label: String) -> Bool {
        label.hasPrefix("Photo ") || label.hasPrefix("Open gallery photo ")
    }

    private func finiteArea(_ frame: CGRect, minimum: CGFloat = 0.5) -> Bool {
        !frame.isNull && !frame.isInfinite && rect(frame).count == 4 &&
        frame.width >= minimum && frame.height >= minimum
    }

    private func referenceGestureReady(_ screen: Int) -> Bool {
        app.state == .runningForeground && app.alerts.count == 0 &&
        app.staticTexts["Preview · \(screen) of 48"].exists && app.buttons[galleryLabel].exists && app.buttons[galleryLabel].isHittable
    }

    private func scrollMarks(_ element: XCUIElement, origin: CGRect, photosOnly: Bool = false) -> [ScrollMark] {
        element.buttons.allElementsBoundByIndex.enumerated().compactMap { ordinal, button in
            let label = button.label
            if photosOnly && !isPhotoAction(label) { return nil }
            let frame = button.frame
            guard finiteArea(frame) else { return nil }
            return ScrollMark(label: label, ordinal: ordinal, x: frame.minX - origin.minX,
                              y: frame.minY - origin.minY, width: frame.width, height: frame.height)
        }
    }

    private func sameMarks(_ left: [ScrollMark], _ right: [ScrollMark], horizontal: Bool) -> Bool {
        guard !left.isEmpty, left.count == right.count else { return false }
        return zip(left, right).allSatisfy { a, b in
            a.label == b.label && a.ordinal == b.ordinal && abs(a.x - b.x) <= 0.5 &&
            abs(a.width - b.width) <= 0.5 &&
            (horizontal || (abs(a.y - b.y) <= 0.5 && abs(a.height - b.height) <= 0.5))
        }
    }

    private func verifiedGridSurface(_ screen: Int) -> (surface: GridSurface?, failure: String?) {
        guard [13, 21, 29, 30].contains(screen), referenceGestureReady(screen) else {
            return (nil, "Grid route/foreground/reference/alert guard failed")
        }
        let predicate = NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Photo ", "Open gallery photo ")
        let candidates = app.scrollViews.allElementsBoundByIndex.enumerated().filter { _, view in
            !view.identifier.hasPrefix("lovelies.horizontal.") && view.buttons.matching(predicate).count > 0
        }
        guard candidates.count == 1, let candidate = candidates.first else {
            return (nil, "Photo grid has no unique nonhorizontal photo-containing ancestor")
        }
        let frame = candidate.element.frame
        var viewport = frame.intersection(app.frame)
        var evidence: [String: Any] = ["source": "fresh unique photo ancestor", "ordinal": candidate.offset,
                                       "scroll_frame": rect(frame), "app_frame": rect(app.frame)]
        if [29, 30].contains(screen) {
            let counts = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^[0-9]+ selected$"))
            let options = app.buttons.matching(identifier: "Selection options")
            let next = app.buttons.matching(identifier: "Choose people to share with")
            guard counts.count == 1, options.count == 1, next.count == 1 else {
                return (nil, "Selection footer count/options/next anchors are not unique")
            }
            let countFrame = counts.element(boundBy: 0).frame
            let optionsFrame = options.element(boundBy: 0).frame
            let nextFrame = next.element(boundBy: 0).frame
            guard [countFrame, optionsFrame, nextFrame].allSatisfy({ finiteArea($0) && app.frame.contains($0) }),
                  optionsFrame.maxX <= countFrame.minX + 0.5, countFrame.maxX <= nextFrame.minX + 0.5,
                  abs(optionsFrame.midY - countFrame.midY) <= 0.5,
                  abs(nextFrame.midY - countFrame.midY) <= 0.5 else {
                return (nil, "Selection footer anchors do not match the source-bound centered HStack")
            }
            // SharingViews.photoSelection has 11pt HStack padding and 13pt grid padding.
            // This source-bound barrier is required because the AX ScrollView extends under the floating footer.
            // Exact frozen source/resource minima for measured mode exceed488pt (29:488.4,30:490.6).
            // This conservative width guard proves the reflow branch even at normal text; wider mode is unqualified.
            let contentWidth = frame.width - 26
            guard contentWidth > 0, contentWidth < 488 else {
                return (nil, "Source content edges are unproved for this selection-grid width/branch")
            }
            evidence["source_layout_branch"] = "source-bound reflow below488pt"
            evidence["grid_content_width"] = Double(contentWidth)
            let barrier = min(countFrame.minY, min(optionsFrame.minY, nextFrame.minY)) - 11
            viewport = viewport.intersection(CGRect(x: app.frame.minX + 13, y: app.frame.minY,
                                                    width: app.frame.width - 26, height: max(0, barrier - app.frame.minY)))
            evidence["footer_source_padding"] = 11
            evidence["footer_count_frame"] = rect(countFrame)
            evidence["footer_options_frame"] = rect(optionsFrame)
            evidence["footer_next_frame"] = rect(nextFrame)
            evidence["footer_barrier_y"] = Double(barrier)
        } else if screen == 21 {
            // UploadViews.selection has 11pt grid padding and 12pt bottom padding.
            // Its source-bound measured minimum is525.8pt. This width guard proves
            // reflow for this route; the fixed header is excluded by ScrollView.frame.
            let contentWidth = frame.width - 22
            guard contentWidth > 0, contentWidth < 525 else {
                return (nil, "Upload photo-grid source edges are unproved for this width/branch")
            }
            viewport = viewport.intersection(CGRect(x: app.frame.minX + 11, y: app.frame.minY,
                                                    width: app.frame.width - 22, height: app.frame.height))
            evidence["source_layout_branch"] = "source-bound reflow below525pt"
            evidence["source_grid_padding"] = 11
            evidence["grid_content_width"] = Double(contentWidth)
        } else {
            // GalleryViews.allPhotos has 12pt grid padding and no bottom overlay in this route.
            viewport = viewport.intersection(CGRect(x: app.frame.minX + 12, y: app.frame.minY,
                                                    width: app.frame.width - 24, height: app.frame.height))
            evidence["source_grid_padding"] = 12
        }
        if app.keyboards.firstMatch.exists {
            let keyboard = app.keyboards.firstMatch.frame
            guard finiteArea(keyboard) else { return (nil, "Keyboard geometry is unknown") }
            viewport = viewport.intersection(CGRect(x: app.frame.minX, y: app.frame.minY,
                                                    width: app.frame.width, height: max(0, keyboard.minY - app.frame.minY)))
            evidence["keyboard_frame"] = rect(keyboard)
        }
        guard finiteArea(viewport, minimum: 44) else { return (nil, "No verified unoccluded 44pt grid viewport") }
        evidence["usable_viewport"] = rect(viewport)
        return (GridSurface(element: candidate.element, ordinal: candidate.offset, viewport: viewport, evidence: evidence), nil)
    }


    private func verifiedGridMarks(_ surface: GridSurface, screen: Int) -> (marks: [ScrollMark]?, failure: String?) {
        let expectedIDs: Set<Int> = screen == 13 ? Set([2, 4, 9, 10, 1, 6, 7, 11, 3, 5, 8, 12, 14]) : screen == 21 ? Set(1...18) : Set(1...12)
        let photoButtons = surface.element.buttons.allElementsBoundByIndex.filter { isPhotoAction($0.label) }
        let marks = scrollMarks(surface.element, origin: surface.viewport, photosOnly: true)
        let ids: [Int] = marks.compactMap { mark in
            let prefix = mark.label.hasPrefix("Photo ") ? "Photo " : "Open gallery photo "
            guard mark.label.hasPrefix(prefix) else { return nil }
            let digits = mark.label.dropFirst(prefix.count).prefix { $0.isNumber }
            return Int(String(digits))
        }
        guard !marks.isEmpty, photoButtons.count == marks.count, ids.count == marks.count,
              ids.count == expectedIDs.count, Set(ids) == expectedIDs else {
            return (nil, "Complete finite source-bound all-photo geometry is unavailable or inconsistent")
        }
        return (marks, nil)
    }

    private func gridContentEdge(_ surface: GridSurface, screen: Int, marks: [ScrollMark], forward: Bool) -> (proved: Bool, evidence: [String: Any]) {
        guard let leading = marks.map(\.y).min(), let photoBottom = marks.map({ $0.y + $0.height }).max() else {
            return (false, ["source_edge_proved": false, "failure": "Empty all-photo geometry"])
        }
        // The source layouts have no leading blank and height=max photo bottom (no final masonry gap).
        // The containing view adds only bottom12 on13/21 or bottom80 on the width-proved reflow29/30 branch.
        let bottomPadding: CGFloat = [13, 21].contains(screen) ? 12 : 80
        let trailing = photoBottom + bottomPadding
        let proved = forward ? trailing <= surface.viewport.height + 0.5 : leading >= -0.5
        return (proved, ["source_edge_proved": proved, "direction": forward ? "trailing" : "leading",
                         "leading_relative_y": Double(leading), "last_photo_relative_bottom": Double(photoBottom),
                         "source_bottom_padding": Double(bottomPadding), "content_trailing_relative_y": Double(trailing),
                         "viewport_height": Double(surface.viewport.height), "photo_count": marks.count,
                         "tolerance_pt": 0.5, "definition": "Complete source content edge exposed; not exact UIScrollView contentOffset maximum",
                         "independent_of_reachable_history": true])
    }

    private func controlledGridDrag(_ surface: GridSurface, screen: Int, marks: [ScrollMark], forward: Bool,
                                    remainingGestures: Int) -> [String: Any] {
        let area = surface.viewport
        let extra: CGFloat = [29, 30].contains(screen) ? 80 : 12
        let extent = forward ? max(0, (marks.map { $0.y + $0.height }.max() ?? area.height) - area.height + extra)
                             : max(0, -(marks.map(\.y).min() ?? 0))
        // Default 20% strokes are increased only to fit the remaining finite budget, never beyond 45%.
        // Actual displacement is recorded; a requested stroke is not a movement or reachability proof.
        let requested = min(area.height * 0.45, max(CGFloat(16), max(area.height * 0.20, extent / CGFloat(max(1, remainingGestures - 2)))))
        let x = area.minX + area.width * 0.24
        let startY = area.minY + area.height * (forward ? 0.75 : 0.25)
        let endY = startY + (forward ? -requested : requested)
        let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        let start = origin.withOffset(CGVector(dx: x - app.frame.minX, dy: startY - app.frame.minY))
        let end = origin.withOffset(CGVector(dx: x - app.frame.minX, dy: endY - app.frame.minY))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
        return ["start": [Double(x), Double(startY)], "end": [Double(x), Double(endY)],
                "requested_stroke": Double(requested), "maximum_fraction": 0.45,
                "default_fraction": 0.20, "extent_estimate": Double(extent), "surface": surface.evidence]
    }

    private func scan(_ screen: Int, variant: String) throws -> [String: Any] {
        var failures = [String]()
        var issues = [[String: Any]]()
        var positions = [[String: Any]]()
        var reachable = Set<String>()
        func sample(_ phase: String) {
            let gridRoute = [13, 21, 29, 30].contains(screen)
            let lookup = gridRoute ? verifiedGridSurface(screen) : (surface: Optional<GridSurface>.none, failure: Optional<String>.none)
            let photoViewport: CGRect? = gridRoute ? (lookup.surface?.viewport ?? CGRect.null) : nil
            let observed = actions(photoViewport: photoViewport)
            if gridRoute, let failure = lookup.failure { failures.append("Verified grid surface unavailable at \(phase): \(failure)") }
            for action in observed where action["hittable"] as? Bool == true && action["enabled"] as? Bool == true {
                let label = action["label"] as? String ?? ""
                if label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { failures.append("Unnamed hittable action at \(phase)") }
                if let area = action["intersection"] as? [Double], area.count == 4,
                   area[2] - area[0] >= 43.5, area[3] - area[1] >= 43.5 { reachable.insert(label) }
            }
            var position: [String: Any] = ["phase": phase, "actions": observed]
            if let surface = lookup.surface { position["verified_grid_surface"] = surface.evidence }
            positions.append(position)
        }
        capture("\(variant)-\(String(format: "%02d", screen))-initial")
        sample("initial")
        do { issues += try audit(phase: "initial") }
        catch { failures.append("Accessibility audit did not complete: \(error)") }
        let horizontalPrefix = "lovelies.horizontal."
        let expectedHorizontal = Set(app.scrollViews.allElementsBoundByIndex.map(\.identifier).filter { $0.hasPrefix(horizontalPrefix) })
        var visitedHorizontal = Set<String>(), horizontalActions = Set<String>()
        var horizontalEvidence = [[String: Any]](), gridEvidence = [[String: Any]]()
        if [15, 33].contains(screen), expectedHorizontal.isEmpty {
            failures.append("Expected horizontal strip has no axis identifier")
        }
        let count = min(app.scrollViews.count, 8)
        if app.scrollViews.count > 8 { failures.append("Scroll container coverage cap exceeded") }
        for index in 0..<count {
            let original = app.scrollViews.element(boundBy: index)
            guard original.exists else { failures.append("Scroll \(index) disappeared before scanning"); continue }
            let identifier = original.identifier
            if identifier.hasPrefix(horizontalPrefix) {
                var exposureMoves = 0, parentRestoreMoves = 0
                var stripObserved = Set<String>(), stripReached = Set<String>()
                var stripSamples = [[String: Any]](), recovery = [[String: Any]]()
                func freshHorizontal() -> (strip: XCUIElement, parent: XCUIElement, viewport: CGRect)? {
                    guard referenceGestureReady(screen) else { return nil }
                    let children = app.scrollViews.matching(identifier: identifier)
                    let parents = app.scrollViews.allElementsBoundByIndex.filter {
                        !$0.identifier.hasPrefix(horizontalPrefix) && finiteArea($0.frame) &&
                        $0.frame.intersects(app.frame) && $0.frame.height >= 100 &&
                        $0.descendants(matching: .scrollView).matching(identifier: identifier).count == 1
                    }
                    guard children.count == 1, parents.count == 1 else { return nil }
                    let child = children.element(boundBy: 0), parent = parents[0]
                    let viewport = child.frame.intersection(parent.frame).intersection(app.frame)
                    return (child, parent, viewport)
                }
                func sampleStrip(_ phase: String) -> [ScrollMark] {
                    guard let fresh = freshHorizontal() else {
                        failures.append("Horizontal strip \(identifier) lost its unique verified ancestry at \(phase)")
                        return []
                    }
                    let observed = actions(in: fresh.strip, viewport: fresh.viewport)
                    for action in observed {
                        let label = action["label"] as? String ?? ""
                        stripObserved.insert(label); horizontalActions.insert(label)
                        if action["hittable"] as? Bool == true && action["enabled"] as? Bool == true {
                            if label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                failures.append("Unnamed action in horizontal strip \(identifier)")
                            }
                            if let area = action["intersection"] as? [Double], area.count == 4,
                               area[2] - area[0] >= 43.5, area[3] - area[1] >= 43.5 { stripReached.insert(label) }
                        }
                    }
                    let marks = scrollMarks(fresh.strip, origin: fresh.strip.frame)
                    stripSamples.append(["phase": phase, "viewport": rect(fresh.viewport), "actions": observed,
                                         "fingerprint": marks.map(\.row)])
                    return marks
                }
                func ensureExposure(_ phase: String) -> (strip: XCUIElement, parent: XCUIElement, viewport: CGRect)? {
                    while true {
                        guard let fresh = freshHorizontal() else {
                            failures.append("Horizontal strip \(identifier) has no unique fresh child/vertical ancestor at \(phase)")
                            return nil
                        }
                        let stripFrame = fresh.strip.frame, parentFrame = fresh.parent.frame
                        let parentViewport = parentFrame.intersection(app.frame)
                        let exposed = finiteArea(fresh.viewport, minimum: 43.5) &&
                            fresh.viewport.height >= min(stripFrame.height, parentViewport.height) - 0.5
                        recovery.append(["phase": phase, "exposure_moves": exposureMoves,
                                         "strip_frame": rect(stripFrame), "parent_frame": rect(parentFrame),
                                         "viewport": rect(fresh.viewport), "exposed": exposed])
                        if exposed {
                            guard fresh.strip.isHittable else {
                                failures.append("Horizontal strip \(identifier) has no native-hittable gesture surface at \(phase)")
                                return nil
                            }
                            return fresh
                        }
                        guard exposureMoves < 20, finiteArea(parentViewport, minimum: 44), fresh.parent.isHittable else {
                            failures.append("Horizontal strip \(identifier) not exposed within 20 total parent gestures at \(phase)")
                            return nil
                        }
                        if stripFrame.midY >= parentFrame.midY { fresh.parent.swipeUp(velocity: .slow) }
                        else { fresh.parent.swipeDown(velocity: .slow) }
                        exposureMoves += 1
                        sample("scroll-\(index)-parent-exposure-\(exposureMoves)")
                        _ = sampleStrip("\(phase)-exposure-\(exposureMoves)")
                    }
                }
                func horizontalSweep(forward: Bool, phase: String, expected: [ScrollMark]? = nil) -> (ended: Bool, marks: [ScrollMark]) {
                    guard let start = ensureExposure("\(phase)-before-start") else { return (false, []) }
                    var previousMarks = scrollMarks(start.strip, origin: start.strip.frame)
                    var previousSignature = signature(), stable = 0
                    guard !previousMarks.isEmpty else {
                        failures.append("Horizontal strip \(identifier) has no fingerprint at \(phase)")
                        return (false, [])
                    }
                    for step in 1...20 {
                        guard let fresh = ensureExposure("\(phase)-before-gesture-\(step)") else { return (false, previousMarks) }
                        if forward { fresh.strip.swipeLeft(velocity: .slow) }
                        else { fresh.strip.swipeRight(velocity: .slow) }
                        sample("scroll-\(index)-horizontal-\(phase)-\(step)")
                        let marks = sampleStrip("\(phase)-\(step)")
                        let current = signature()
                        stable = current == previousSignature && sameMarks(previousMarks, marks, horizontal: true) ? stable + 1 : 0
                        previousSignature = current; previousMarks = marks
                        if stable >= 2 {
                            let edgeCandidate = forward ? marks.last : marks.first
                            guard let edge = edgeCandidate, let currentSurface = freshHorizontal(),
                                  (forward ? edge.x + edge.width <= currentSurface.strip.frame.width + 0.5 : edge.x >= -0.5) else {
                                failures.append("Horizontal strip \(identifier) stable \(phase) state does not expose the actual content edge")
                                return (false, marks)
                            }
                            if let expected, !sameMarks(expected, marks, horizontal: true) {
                                failures.append("Horizontal strip \(identifier) stable endpoint does not match its recorded fingerprint at \(phase)")
                                return (false, marks)
                            }
                            return (true, marks)
                        }
                    }
                    failures.append("Horizontal strip \(identifier) \(phase) end not proved within 20 gestures")
                    return (false, previousMarks)
                }
                func restoreParent() -> Bool {
                    var previous = signature(), stable = 0
                    for step in 1...20 {
                        guard let fresh = freshHorizontal(), finiteArea(fresh.parent.frame.intersection(app.frame), minimum: 44),
                              fresh.parent.isHittable else {
                            failures.append("Parent restoration lost verified ancestry/surface for \(identifier)")
                            return false
                        }
                        fresh.parent.swipeDown(velocity: .slow); parentRestoreMoves += 1
                        sample("scroll-\(index)-parent-restore-\(step)")
                        let current = signature()
                        stable = current == previous ? stable + 1 : 0
                        previous = current
                        if stable >= 2 { return true }
                    }
                    failures.append("Parent scroll start not restored after horizontal strip \(identifier)")
                    return false
                }
                guard ensureExposure("initial") != nil else {
                    horizontalEvidence.append(["identifier": identifier, "exposed": false, "parent_verified": false,
                                               "recovery": recovery, "parent_restored": false])
                    continue
                }
                visitedHorizontal.insert(identifier)
                // Normalize the fresh start with a separate capped reverse sweep before saving its fingerprint.
                // This cannot count as the actual backward restoration after the forward/audit phase.
                let normalized = horizontalSweep(forward: false, phase: "initial-start-normalization")
                guard normalized.ended else {
                    let restored = restoreParent()
                    horizontalEvidence.append(["identifier": identifier, "exposed": true, "start_proved": false,
                                               "parent_restored": restored, "recovery": recovery, "samples": stripSamples])
                    continue
                }
                let startFingerprint = normalized.marks
                let forward = horizontalSweep(forward: true, phase: "forward")
                capture("\(variant)-\(String(format: "%02d", screen))-scroll-\(index)-horizontal-end")
                do { issues += try audit(phase: "scroll-\(index)-horizontal-end") }
                catch { failures.append("End accessibility audit did not complete: \(error)") }
                var reconstructed = false
                if forward.ended, let fresh = ensureExposure("after-end-audit") {
                    let current = scrollMarks(fresh.strip, origin: fresh.strip.frame)
                    if sameMarks(forward.marks, current, horizontal: true) { reconstructed = true }
                    else {
                        recovery.append(["phase": "audit-axis-reset-detected", "expected_end": forward.marks.map(\.row),
                                         "observed_after_exposure": current.map(\.row)])
                        let rebuilt = horizontalSweep(forward: true, phase: "end-reconstruction", expected: forward.marks)
                        reconstructed = rebuilt.ended
                        capture("\(variant)-\(String(format: "%02d", screen))-scroll-\(index)-horizontal-end-reconstructed")
                    }
                }
                if !forward.ended { failures.append("Scroll \(index) horizontal forward end was not proved") }
                if !reconstructed { failures.append("Horizontal strip \(identifier) post-audit forward endpoint was not reconstructed/verified") }
                let backward = reconstructed ? horizontalSweep(forward: false, phase: "backward", expected: startFingerprint) : (ended: false, marks: [ScrollMark]())
                if !backward.ended { failures.append("Scroll \(index) horizontal start was not restored from the verified forward endpoint") }
                for label in stripObserved.subtracting(stripReached).sorted() {
                    failures.append("Horizontal strip \(identifier) action never reached a hittable 44pt visible area: \(label)")
                }
                let restored = restoreParent()
                horizontalEvidence.append(["identifier": identifier, "parent_verified": true, "exposed": true,
                                           "seek_moves": exposureMoves, "parent_restore_moves": parentRestoreMoves,
                                           "parent_restored": restored, "start_proved": normalized.ended,
                                           "start_fingerprint": startFingerprint.map(\.row), "forward_end_fingerprint": forward.marks.map(\.row),
                                           "forward_ended": forward.ended, "end_reconstructed_after_audit": reconstructed,
                                           "backward_restored": backward.ended, "observed_labels": stripObserved.sorted(),
                                           "reached_44pt_labels": stripReached.sorted(), "recovery": recovery, "samples": stripSamples])
                continue
            }
            if [13, 21, 29, 30].contains(screen), original.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Photo ", "Open gallery photo ")).count > 0 {
                var gestureEvidence = [[String: Any]](), skippedIntervals = [[String: Any]]()
                func gridSweep(forward: Bool, phase: String, expected: [ScrollMark]? = nil) -> (ended: Bool, marks: [ScrollMark]) {
                    let first = verifiedGridSurface(screen)
                    guard let firstSurface = first.surface, firstSurface.ordinal == index else {
                        failures.append("Grid \(index) \(phase): \(first.failure ?? "ancestor changed")")
                        return (false, [])
                    }
                    let firstGeometry = verifiedGridMarks(firstSurface, screen: screen)
                    guard let initialMarks = firstGeometry.marks else {
                        failures.append("Grid \(index) \(phase): \(firstGeometry.failure ?? "all-photo geometry unproved")")
                        return (false, [])
                    }
                    var previousMarks = initialMarks
                    var previousSignature = signature(), stable = 0
                    let movementBudget = 20
                    let endpointConfirmationBudget = 2
                    for step in 1...(movementBudget + endpointConfirmationBudget) {
                        let lookup = verifiedGridSurface(screen)
                        guard let fresh = lookup.surface, fresh.ordinal == index else {
                            failures.append("Grid \(index) lost verified unoccluded surface at \(phase)-\(step): \(lookup.failure ?? "ancestor changed")")
                            return (false, previousMarks)
                        }
                        let beforeGeometry = verifiedGridMarks(fresh, screen: screen)
                        guard let before = beforeGeometry.marks else {
                            failures.append("Grid \(index) \(phase) before gesture: \(beforeGeometry.failure ?? "all-photo geometry unproved")")
                            return (false, previousMarks)
                        }
                        // Extra probes may confirm an already exposed source edge only.
                        // They cannot extend the movement budget or accept a stalled mid-grid state.
                        if step > movementBudget && !gridContentEdge(fresh, screen: screen, marks: before, forward: forward).proved {
                            failures.append("Grid \(index) \(phase) source edge not exposed within \(movementBudget) controlled drags")
                            return (false, before)
                        }
                        let requested = controlledGridDrag(fresh, screen: screen, marks: before, forward: forward,
                                                           remainingGestures: max(1, movementBudget + 1 - step))
                        sample("scroll-\(index)-vertical-\(phase)-\(step)")
                        let afterLookup = verifiedGridSurface(screen)
                        guard let afterSurface = afterLookup.surface, afterSurface.ordinal == index else {
                            failures.append("Grid \(index) surface unknown after \(phase)-\(step): \(afterLookup.failure ?? "ancestor changed")")
                            return (false, previousMarks)
                        }
                        let afterGeometry = verifiedGridMarks(afterSurface, screen: screen)
                        guard let after = afterGeometry.marks else {
                            failures.append("Grid \(index) \(phase) after gesture: \(afterGeometry.failure ?? "all-photo geometry unproved")")
                            return (false, previousMarks)
                        }
                        let edge = gridContentEdge(afterSurface, screen: screen, marks: after, forward: forward)
                        let matched = before.compactMap { a -> (ScrollMark, ScrollMark)? in
                            guard let b = after.first(where: { $0.label == a.label && $0.ordinal == a.ordinal }) else { return nil }
                            return (a, b)
                        }
                        let deltas = matched.map { $0.0.y - $0.1.y }.sorted()
                        let medianDelta = deltas.isEmpty ? nil : deltas[deltas.count / 2]
                        for (a, b) in matched {
                            let top = CGFloat(0), bottom = fresh.viewport.height
                            let skipped = forward ? (a.y > bottom - 43.5 && b.y + b.height < top + 43.5)
                                                  : (a.y + a.height < top + 43.5 && b.y > bottom - 43.5)
                            if skipped { skippedIntervals.append(["phase": phase, "step": step, "label": a.label,
                                                                  "before": a.row, "after": b.row,
                                                                  "note": "Potential 44pt interval crossed between samples; no reachability credit without an actual later sample."]) }
                        }
                        let current = signature()
                        stable = current == previousSignature && sameMarks(previousMarks, after, horizontal: false) ? stable + 1 : 0
                        gestureEvidence.append(["phase": phase, "step": step, "request": requested,
                                                "before": before.map(\.row), "after": after.map(\.row),
                                                "actual_median_photo_delta": medianDelta.map { Double($0) as Any } ?? NSNull(),
                                                "stable_samples": stable, "source_content_edge": edge.evidence])
                        if let medianDelta, (forward && medianDelta < -0.5 || !forward && medianDelta > 0.5) {
                            failures.append("Grid \(index) moved opposite the requested \(phase) direction")
                            return (false, after)
                        }
                        previousSignature = current; previousMarks = after
                        if stable >= 2 {
                            guard edge.proved else {
                                failures.append("Grid \(index) stable \(phase) state has no unconditional source content-edge exposure proof")
                                return (false, after)
                            }
                            if let expected, !sameMarks(expected, after, horizontal: false) {
                                failures.append("Grid \(index) stable \(phase) endpoint differs from recorded fingerprint")
                                return (false, after)
                            }
                            return (true, after)
                        }
                    }
                    failures.append("Grid \(index) \(phase) end not proved within \(movementBudget) controlled drags and \(endpointConfirmationBudget) source-edge confirmation probes")
                    return (false, previousMarks)
                }
                let normalized = gridSweep(forward: false, phase: "initial-start-normalization")
                let startFingerprint = normalized.marks
                let forward = normalized.ended ? gridSweep(forward: true, phase: "forward") : (ended: false, marks: [ScrollMark]())
                capture("\(variant)-\(String(format: "%02d", screen))-scroll-\(index)-vertical-end")
                do { issues += try audit(phase: "scroll-\(index)-vertical-end") }
                catch { failures.append("End accessibility audit did not complete: \(error)") }
                var reconstructed = false
                if forward.ended {
                    let fresh = verifiedGridSurface(screen)
                    if let surface = fresh.surface, surface.ordinal == index {
                        let currentGeometry = verifiedGridMarks(surface, screen: screen)
                        if let current = currentGeometry.marks {
                            let currentEdge = gridContentEdge(surface, screen: screen, marks: current, forward: true)
                            if currentEdge.proved && sameMarks(forward.marks, current, horizontal: false) { reconstructed = true }
                            else { reconstructed = gridSweep(forward: true, phase: "end-reconstruction", expected: forward.marks).ended }
                        } else {
                            failures.append("Grid \(index) post-audit endpoint geometry unproved: \(currentGeometry.failure ?? "unknown geometry")")
                        }
                    }
                }
                let backward = reconstructed ? gridSweep(forward: false, phase: "backward", expected: startFingerprint) : (ended: false, marks: [ScrollMark]())
                if !forward.ended { failures.append("Scroll \(index) vertical forward end was not proved") }
                if !reconstructed { failures.append("Grid \(index) post-audit forward endpoint was not reconstructed/verified") }
                if !backward.ended { failures.append("Scroll \(index) vertical start was not restored from the verified forward endpoint") }
                gridEvidence.append(["scroll_index": index, "start_proved": normalized.ended,
                                     "forward_ended": forward.ended, "backward_restored": backward.ended,
                                     "end_reconstructed_after_audit": reconstructed,
                                     "start_fingerprint": startFingerprint.map(\.row), "forward_end_fingerprint": forward.marks.map(\.row),
                                     "gestures": gestureEvidence, "unsampled_intervals": skippedIntervals])
                continue
            }
            // All other vertical consumers retain c6's bounded native swipe and audit behavior.
            let scroll = app.scrollViews.element(boundBy: index)
            guard scroll.exists, scroll.frame.width >= 44, scroll.frame.height >= 44 else { continue }
            if !scroll.frame.intersects(app.frame) { continue }
            var previous = signature(), stable = 0, ended = false
            for step in 1...20 {
                scroll.swipeUp(velocity: .slow)
                sample("scroll-\(index)-vertical-forward-\(step)")
                let current = signature()
                stable = current == previous ? stable + 1 : 0
                previous = current
                if stable >= 2 { ended = true; break }
            }
            if !ended { failures.append("Scroll \(index) vertical forward end not observed within 20 gestures") }
            capture("\(variant)-\(String(format: "%02d", screen))-scroll-\(index)-vertical-end")
            do { issues += try audit(phase: "scroll-\(index)-vertical-end") }
            catch { failures.append("End accessibility audit did not complete: \(error)") }
            previous = signature(); stable = 0; ended = false
            for step in 1...20 {
                scroll.swipeDown(velocity: .slow)
                sample("scroll-\(index)-vertical-backward-\(step)")
                let current = signature()
                stable = current == previous ? stable + 1 : 0
                previous = current
                if stable >= 2 { ended = true; break }
            }
            if !ended { failures.append("Scroll \(index) vertical start not restored within 20 gestures") }
        }
        for identifier in expectedHorizontal.subtracting(visitedHorizontal).sorted() {
            failures.append("Horizontal strip was not audited: \(identifier)")
        }
        let required: [Int: [String]] = [1: ["Get started"], 2: ["Get Started"], 3: ["Sign In"], 11: ["New Matches"], 12: ["People in this photo", "3 more people", "Add to favorites", "Share photo"], 20: ["Take a Photo"], 21: ["Cancel"], 24: ["View in Library"], 27: ["Sophie", "Mark", "Emma", "James", "Olivia", "Daniel", "Maya", "More people"], 33: ["Share Photos"], 43: ["Manage Storage"], 48: ["Go Back"]]
        for label in required[screen] ?? [] where !reachable.contains(where: { $0 == label || $0.hasPrefix(label + ",") || $0.hasPrefix(label + "\n") || $0.hasPrefix(label + " ") }) { failures.append("Required action never reached a hittable 44pt visible area: \(label)") }
        let observedPhotoActions = Set(positions.flatMap { $0["actions"] as? [[String: Any]] ?? [] }
            .compactMap { $0["label"] as? String }.filter { $0.hasPrefix("Photo ") || $0.hasPrefix("Open gallery photo ") })
        for label in observedPhotoActions.sorted() where !reachable.contains(label) {
            failures.append("Photo action never reached a hittable 44pt visible area: \(label)")
        }
        var navigation: [String: Any] = ["kind": "primary navigation / review gallery"]
        if ![1, 10, 11, 37].contains(screen) {
            let labels = screen == 23 ? ["Cancel upload"] : ["Back", "Close", "Cancel", "Back to photo", "Go Back", "Back to setup", "Back to review"]
            if let back = labels.map({ app.buttons.matching(identifier: $0).firstMatch }).first(where: { $0.exists && $0.isHittable }) {
                let label = back.label
                let visibleExit = back.frame.intersection(app.frame)
                let exitMeets44 = !visibleExit.isNull && visibleExit.width >= 43.5 && visibleExit.height >= 43.5
                if !exitMeets44 { failures.append("Exit action lacks a hittable 44pt visible area: \(label)") }
                back.tap()
                let expected = screen == 23 ? 21 : screen == 21 ? 19 : 1
                if screen == 23 {
                    let selection = app.alerts.buttons["Back to selection"]
                    if selection.waitForExistence(timeout: 3) { selection.tap() }
                    else { failures.append("Upload cancellation did not offer Back to selection") }
                }
                let returned = app.staticTexts["Preview · \(expected) of 48"].waitForExistence(timeout: 5)
                navigation = ["kind": "Back / Close / Cancel", "label": label, "expected_screen": expected, "reached": returned, "visible_frame": rect(visibleExit), "visible_44pt": exitMeets44]
                if !returned { failures.append("Navigation did not return to screen \(expected)") }
            } else { failures.append("No hittable Back, Close or Cancel action after restoring scroll") }
        }
        return ["screen": screen, "variant": variant, "failures": failures, "audit_issues": issues,
                "positions": positions, "observed_photo_action_labels": observedPhotoActions.sorted(),
                "horizontal_scroll_ids": visitedHorizontal.sorted(), "horizontal_action_labels": horizontalActions.sorted(),
                "horizontal_evidence": horizontalEvidence, "grid_evidence": gridEvidence,
                "reachable_44pt_labels": reachable.sorted(), "navigation": navigation,
                "status": failures.isEmpty && issues.isEmpty ? "passed" : "failed"]
    }

    func test01ReferenceLifecycleAndCatalog() throws {
        try launch()
        XCTAssertTrue(app.staticTexts["Preview · 1 of 48"].exists)
        let normalBannerHeight = app.staticTexts["Preview · 1 of 48"].frame.height
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["Preview · 1 of 48"].waitForExistence(timeout: 8))
        app.open(URL(string: "lovelies://preview-isolation-check")!)
        XCTAssertTrue(app.staticTexts["Preview · 1 of 48"].waitForExistence(timeout: 8))
        try choose(20)
        capture("smoke-source-picker")
        XCTAssertTrue(app.buttons[galleryLabel].isHittable)
        try choose(40)
        let findability = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Who can find you")).firstMatch
        XCTAssertTrue(findability.waitForExistence(timeout: 5))
        XCTAssertTrue(findability.label.contains("Anyone"))
        capture("smoke-anyone-default")
        try launch(large: true)
        let largeBannerHeight = app.staticTexts["Preview · 1 of 48"].frame.height
        let overrideObserved = largeBannerHeight > normalBannerHeight + 0.5
        capture("smoke-largest-type")
        try attachJSON(["status": "passed", "reference_foreground": true, "reference_after_activation": true,
                        "reference_after_custom_url": true, "catalog_routes": [20, 40], "photo_access_or_provider_tested": false,
                        "normal_banner_height": normalBannerHeight, "large_banner_height": largeBannerHeight,
                        "type_override_observed": overrideObserved], name: "reference-smoke.json")
        XCTAssertTrue(overrideObserved, "Largest-type launch request must produce observable typography growth before counting that matrix")
    }

    func test02AllScreensNormal() throws { try matrix(large: false) }
    func test03AllScreensLargestType() throws { try matrix(large: true) }

    private func matrix(large: Bool) throws {
        let first = Int(ProcessInfo.processInfo.environment["LOVELIES_FIRST_SCREEN"] ?? "1") ?? 1
        let last = Int(ProcessInfo.processInfo.environment["LOVELIES_LAST_SCREEN"] ?? "48") ?? 48
        XCTAssertTrue((1...48).contains(first) && (first...48).contains(last))
        try launch(large: large)
        let variant = large ? "largest-type-requested" : "normal"
        rows = []
        for screen in first...last {
            // Start each screen with a fresh reference process for this isolated matrix.
            if screen != first { try launch(large: large) }
            // Gallery navigation starts from splash, making the actual Back destination deterministic.
            if screen != 1 { try choose(1) }
            try choose(screen)
            rows.append(try scan(screen, variant: variant))
            try attachJSON(rows.last!, name: "\(variant)-\(String(format: "%02d", screen))-report.json")
        }
        try attachJSON(["reference_only": true, "variant": variant,
                        "per_screen_process_isolation": true, "continuous_session_verified": false,
                        "first_screen": first, "last_screen": last,
                        "requested_type": large ? largestType : "system default", "screens": rows,
                        "spoken_voiceover_verified": false, "global_settings_changed": false], name: "\(variant)-matrix.json")
        XCTAssertEqual(rows.filter { $0["status"] as? String != "passed" }.count, 0, "Inspect retained per-screen reports and accessibility audit issues")
    }

    func test05NativePreferenceSwitchTargets() throws {
        try launch()
        let groups: [(Int, [(String, String)])] = [
            (40, [("Allow others to save", "1"), ("Show location info", "0"), ("Show in suggestions", "1"), ("Analytics", "0")]),
            (42, [("New Matches", "1"), ("Messages", "1"), ("Mentions", "1"), ("Tips & Features", "1"), ("Reminders", "0"), ("Marketing", "0")])
        ]
        let offsets: [(String, CGVector)] = [
            ("centre", CGVector(dx: 0, dy: 0)),
            ("upper-left", CGVector(dx: -21, dy: -21)), ("top", CGVector(dx: 0, dy: -21)), ("upper-right", CGVector(dx: 21, dy: -21)),
            ("lower-left", CGVector(dx: -21, dy: 21)), ("bottom", CGVector(dx: 0, dy: 21)), ("lower-right", CGVector(dx: 21, dy: 21))
        ]
        var probes = [[String: Any]](), failures = [String]()
        for (screen, expected) in groups {
            try choose(screen)
            XCTAssertEqual(app.switches.count, expected.count, "Each preference must expose one native switch")
            for (label, initial) in expected {
                let matches = app.switches.matching(identifier: label)
                XCTAssertEqual(matches.count, 1, "Preference label must be unique: \(label)")
                let control = matches.firstMatch
                XCTAssertEqual(control.value as? String, initial, "Reference default changed: \(label)")
                XCTAssertTrue(control.isEnabled && control.isHittable)
                XCTAssertGreaterThanOrEqual(control.frame.width, 44)
                XCTAssertGreaterThanOrEqual(control.frame.height, 44)
                for (probe, offset) in offsets {
                    let before = control.value as? String ?? ""
                    XCTAssertTrue(["0", "1"].contains(before), "Unknown switch value; stop before input")
                    let target = before == "1" ? "0" : "1"
                    let frame = control.frame
                    control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(offset).tap()
                    let flipped = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", target), object: control)], timeout: 2) == .completed
                    let after = control.value as? String ?? ""
                    XCTAssertTrue(["0", "1"].contains(after), "Unknown activation outcome; stop before restoration input")
                    if !flipped { failures.append("\(screen) \(label) missed \(probe) at exact frame-relative offset") }
                    if after != before {
                        control.tap()
                        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", before), object: control)], timeout: 2), .completed, "Restore \(label) before continuing")
                    }
                    let adjacentUnchanged = expected.allSatisfy { app.switches[$0.0].value as? String == $0.1 }
                    XCTAssertTrue(adjacentUnchanged, "Unexpected preference change; stop further input")
                    probes.append(["screen": screen, "label": label, "probe": probe, "frame": rect(frame),
                                   "offset": [Double(offset.dx), Double(offset.dy)], "before": before, "after": after,
                                   "flipped": flipped, "restored": control.value as? String == before, "adjacent_unchanged": adjacentUnchanged])
                }
            }
            capture("native-switch-targets-\(screen)-restored")
        }
        try attachJSON(["reference_only": true, "coordinate_scope": "Exact XCUIElement frame-relative native points, without Mac display calibration",
                        "probes": probes, "failures": failures, "spoken_voiceover_verified": false], name: "native-switch-targets.json")
        XCTAssertEqual(probes.count, 70)
        XCTAssertTrue(failures.isEmpty, "Physical target misses remain in native-switch-targets.json")
    }

    func test06PostAuditSettingsContinuity() throws {
        var reports = [[String: Any]]()
        for large in [false, true] {
            try launch(large: large)
            for screen in [40, 41, 42] {
                let started = Date.timeIntervalSinceReferenceDate
                try choose(screen)
                let selected = Date.timeIntervalSinceReferenceDate
                var row = try scan(screen, variant: large ? "continuous-largest" : "continuous-normal")
                row["choose_seconds"] = selected - started
                row["scan_seconds"] = Date.timeIntervalSinceReferenceDate - selected
                reports.append(row)
                try attachJSON(row, name: "continuous-\(large ? "largest" : "normal")-\(screen).json")
            }
        }
        let navigationComplete = reports.count == 6 && reports.allSatisfy { ($0["navigation"] as? [String: Any])?["reached"] as? Bool == true }
        try attachJSON(["reference_only": true, "per_screen_process_isolation": false, "one_launch_per_type_variant": true,
                        "continuous_session_screen_scope": [40, 41, 42], "continuous_navigation_completed": navigationComplete,
                        "screens": reports, "spoken_voiceover_verified": false], name: "post-audit-settings-continuity.json")
        XCTAssertTrue(navigationComplete)
        XCTAssertEqual(reports.filter { $0["status"] as? String != "passed" }.count, 0, "Native and custom findings remain unwaived in the continuity report")
    }

    func test07KinyarwandaPreferenceSemantics() throws {
        let groups: [(Int, [(String, String, String)])] = [
            (40, [("Allow others to save", "Emera ko abandi babika", "1"), ("Show location info", "Garagaza amakuru y’ahantu", "0"),
                  ("Show in suggestions", "Garagaza mu bitekerezo bitangwa", "1"), ("Analytics", "Isesengura ry’imikoreshereze", "0")]),
            (42, [("New Matches", "Ibishya byahujwe", "1"), ("Messages", "Ubutumwa", "1"), ("Mentions", "Aho wavuzwe", "1"),
                  ("Tips & Features", "Inama n’ibikorwa bya porogaramu", "1"), ("Reminders", "Ibyibutsa", "0"), ("Marketing", "Kwamamaza", "0")])
        ]
        func captureLocalized(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        var results = [[String: Any]]()
        for locale in ["rw_RW", "en_US"] {
            app.launchArguments = ["--reference-preview", "-AppleLanguages", "(rw)", "-AppleLocale", locale]
            app.launch()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
            let notice = app.alerts["Reba icyitegererezo cya Lovelies"]
            if notice.waitForExistence(timeout: 3) { notice.buttons["Reba paji za porogaramu"].tap() }
            let gallery = app.buttons["Funga icyitegererezo ufungure paji zacyo"]
            XCTAssertTrue(gallery.waitForExistence(timeout: 8), "App language must actually be Kinyarwanda before counting locale evidence")
            for (screen, expected) in groups {
                gallery.tap()
                XCTAssertTrue(app.navigationBars["Paji z’icyitegererezo"].waitForExistence(timeout: 5))
                let search = app.searchFields.firstMatch
                XCTAssertTrue(search.waitForExistence(timeout: 5))
                search.tap()
                if let value = search.value as? String, value != "Shakisha paji", !value.isEmpty {
                    search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
                }
                search.typeText(String(screen))
                let cell = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", String(format: "%02d", screen))).firstMatch
                XCTAssertTrue(cell.waitForExistence(timeout: 5)); cell.tap()
                XCTAssertTrue(app.staticTexts["Icyitegererezo · \(screen) muri 48"].waitForExistence(timeout: 5))
                XCTAssertEqual(app.switches.count, expected.count)
                captureLocalized("rw-\(locale)-\(screen)-initial")
                for (english, localized, initial) in expected {
                    let matches = app.switches.matching(identifier: localized)
                    XCTAssertEqual(matches.count, 1, "Visible and accessible preference language must agree: \(english), locale \(locale)")
                    XCTAssertFalse(app.switches[english].exists)
                    let control = matches.firstMatch
                    for _ in 0..<6 {
                        let visible = control.frame.intersection(app.frame)
                        if control.isHittable && !visible.isNull && visible.height >= 44 { break }
                        app.scrollViews.firstMatch.swipeUp(velocity: .slow)
                    }
                    XCTAssertTrue(control.isHittable)
                    XCTAssertGreaterThanOrEqual(control.frame.intersection(app.frame).height, 44)
                    XCTAssertEqual(control.value as? String, initial)
                    control.tap()
                    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", initial == "1" ? "0" : "1"), object: control)], timeout: 2), .completed)
                    control.tap()
                    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", initial), object: control)], timeout: 2), .completed)
                    results.append(["screen": screen, "app_language": "rw", "locale": locale, "label": control.label,
                                    "english_key": english, "value_restored": control.value as? String == initial, "frame": rect(control.frame)])
                }
                captureLocalized("rw-\(locale)-\(screen)-restored")
                let back = app.buttons["Subira inyuma"]
                XCTAssertTrue(back.isHittable); back.tap()
                XCTAssertTrue(app.staticTexts["Icyitegererezo · 1 muri 48"].waitForExistence(timeout: 5))
            }
        }
        try attachJSON(["reference_only": true, "controls": results, "spoken_voiceover_verified": false,
                        "scope": "Kinyarwanda app language with Rwanda and US locale overrides; no global settings changed"], name: "rw-preference-semantics.json")
        XCTAssertEqual(results.count, 20)
    }

    func test04KeyboardLargestType() throws {
        var results = [[String: Any]]()
        for screen in [15, 22, 45] {
            try launch(large: true)
            try choose(screen)
            let field = (app.textFields.allElementsBoundByIndex + app.textViews.allElementsBoundByIndex).first { $0.exists && $0.isHittable }
            XCTAssertNotNil(field, "No visible input on screen \(screen)")
            guard let field else { continue }
            field.tap(); field.typeText("review")
            let keyboard = app.keyboards.firstMatch
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
            let overlap = field.frame.intersection(keyboard.frame)
            let visible = field.isHittable && !field.frame.isEmpty && (overlap.isNull || overlap.isEmpty)
            capture("keyboard-largest-type-\(screen)")
            results.append(["screen": screen, "field": rect(field.frame), "keyboard": rect(keyboard.frame), "field_visible_above_keyboard": visible])
            XCTAssertTrue(visible, "Focused field is obscured by keyboard")
            app.terminate()
        }
        try attachJSON(results, name: "keyboard-largest-type.json")
    }

    /// Bounded functional follow-ups on the same installed reference app. Slow
    /// drags expose real row geometry before any center-coordinate interaction.
    func test08BoundedRecipientAndReadNotificationFollowups() throws {
        var probes = [[String: Any]]()
        func checkpoint() throws {
            try attachJSON(["reference_only": true, "probes": probes,
                            "provider_or_send_action": false,
                            "scope": "Bounded maximum31, normal39 and normal18 reference follow-ups; native issues retained separately"],
                           name: "bounded-followup-checkpoint-\(probes.count).json")
        }
        func named(_ name: String) -> XCUIElement {
            app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        }
        func recipient(_ name: String) -> XCUIElement {
            // SwiftUI exposes an inner semantic Other named Emma and an outer
            // physical Button named Emma, Matched in 3 photos. Their frames differ.
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name + ",")).firstMatch
        }
        func record(_ element: XCUIElement) -> [String: Any] {
            ["label": element.label, "frame": rect(element.frame), "value": String(describing: element.value ?? ""),
             "selected": element.isSelected, "enabled": element.isEnabled,
             "hittable": element.frame.intersects(app.frame) ? element.isHittable : false]
        }
        func surface() throws -> CGRect {
            let scrolls = app.scrollViews.allElementsBoundByIndex.filter { $0.exists && !$0.frame.intersection(app.frame).isEmpty }
            XCTAssertEqual(scrolls.count, 1, "Expected exactly one current app scroll surface")
            return try XCTUnwrap(scrolls.first).frame.intersection(app.frame)
        }
        func visible(_ element: XCUIElement, in area: CGRect) -> Bool {
            guard element.exists else { return false }
            let frame = element.frame
            return !frame.isEmpty && frame.minY >= area.minY - 0.5 && frame.maxY <= area.maxY + 0.5
                && frame.minX >= app.frame.minX && frame.maxX <= app.frame.maxX && element.isHittable
        }
        func drag(_ area: CGRect, forward: Bool, remaining: CGFloat) {
            let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let length = max(CGFloat(12), min(CGFloat(55), min(area.height * 0.30, remaining)))
            let x = area.minX + area.width * 0.82
            let startY = area.minY + area.height * (forward ? 0.72 : 0.28)
            let endY = startY + (forward ? -length : length)
            origin.withOffset(CGVector(dx: x - app.frame.minX, dy: startY - app.frame.minY))
                .press(forDuration: 0.05,
                       thenDragTo: origin.withOffset(CGVector(dx: x - app.frame.minX, dy: endY - app.frame.minY)),
                       withVelocity: XCUIGestureVelocity(rawValue: 40), thenHoldForDuration: 0.25)
        }
        func reveal(_ element: XCUIElement) throws -> (CGRect, Int) {
            XCTAssertTrue(element.waitForExistence(timeout: 5))
            var geometry = [[String: Any]]()
            for step in 0...32 {
                let area = try surface()
                geometry.append(["step": step, "viewport": rect(area), "element": record(element)])
                if visible(element, in: area) {
                    try attachJSON(geometry, name: "bounded-reveal-\(element.label)-geometry.json")
                    return (area, step)
                }
                if step == 32 {
                    try attachJSON(geometry, name: "bounded-reveal-failed-geometry.json")
                    capture("bounded-reveal-failed")
                    XCTFail("Could not physically expose \(element.label) with bounded slow drags")
                    break
                }
                drag(area, forward: element.frame.midY > area.midY,
                     remaining: abs(element.frame.midY - area.midY))
            }
            throw NSError(domain: "LoveliesBoundedFollowup", code: 1)
        }
        func centerTap(_ element: XCUIElement, area: CGRect) {
            XCTAssertTrue(visible(element, in: area), "No offscreen row activation is permitted")
            let frame = element.frame
            let intersection = frame.intersection(area)
            XCTAssertGreaterThanOrEqual(frame.width, 44)
            XCTAssertGreaterThanOrEqual(frame.height, 44)
            XCTAssertGreaterThanOrEqual(intersection.width, 44)
            XCTAssertGreaterThanOrEqual(intersection.height, 44)
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        try launch(large: true)
        try choose(31)
        XCTAssertTrue(app.staticTexts["5 of 8 selected"].exists)
        for name in ["Emma", "Daniel"] {
            let element = recipient(name)
            let semantic = named(name)
            let (area, steps) = try reveal(element)
            let before = record(element)
            capture("bounded-maximum31-\(name)-before")
            let oldValue = String(describing: semantic.value ?? "")
            centerTap(element, area: area)
            XCTAssertNotEqual(String(describing: semantic.value ?? ""), oldValue)
            let changed = record(element)
            capture("bounded-maximum31-\(name)-changed")
            let restoreArea = try reveal(element).0
            centerTap(element, area: restoreArea)
            XCTAssertEqual(String(describing: semantic.value ?? ""), oldValue)
            capture("bounded-maximum31-\(name)-restored")
            probes.append(["probe": "maximum31-\(name)", "slow_drags": steps,
                           "viewport": rect(area), "before": before, "changed": changed,
                           "restored": record(element), "semantic_value_restored": String(describing: semantic.value ?? "")])
            try checkpoint()
        }
        XCTAssertTrue(app.staticTexts["5 of 8 selected"].exists)
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Preview · 33 of 48"].waitForExistence(timeout: 5))
        capture("bounded-maximum31-continue33")
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Preview · 31 of 48"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["5 of 8 selected"].exists)
        probes.append(["probe": "maximum31-continue-and-back", "selection_restored": true])
        try checkpoint()

        try launch()
        try choose(31)
        try choose(39)
        XCTAssertTrue(app.buttons["Allowed (8)"].exists)
        XCTAssertTrue(app.buttons["Blocked (3)"].exists)
        let sophie = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sophie Chen")).firstMatch
        centerTap(sophie, area: try reveal(sophie).0)
        XCTAssertTrue(app.buttons["Block Person"].waitForExistence(timeout: 5))
        capture("bounded-normal39-before-block")
        app.buttons["Block Person"].tap()
        XCTAssertTrue(app.buttons["Allowed (7)"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Blocked (4)"].exists)
        capture("bounded-normal39-blocked-counts")
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Preview · 31 of 48"].waitForExistence(timeout: 5))
        let blocked = recipient("Sophie")
        XCTAssertFalse(blocked.isEnabled)
        XCTAssertEqual(String(describing: named("Sophie").value ?? ""), "Blocked")
        XCTAssertTrue(app.staticTexts["4 of 8 selected"].exists)
        capture("bounded-normal31-blocked-selection-pruned")
        probes.append(["probe": "normal39-block", "allowed": 7, "blocked": 4,
                       "recipient": record(blocked), "selection_count": "4 of 8 selected"])
        try checkpoint()
        try choose(39)
        app.buttons["Blocked (4)"].tap()
        let excluded = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sophie Chen")).firstMatch
        centerTap(excluded, area: try reveal(excluded).0)
        XCTAssertTrue(app.buttons["Unblock Person"].waitForExistence(timeout: 5))
        capture("bounded-normal39-before-unblock")
        app.buttons["Unblock Person"].tap()
        XCTAssertTrue(app.buttons["Allowed (8)"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Blocked (3)"].exists)
        capture("bounded-normal39-unblocked-counts")
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Preview · 31 of 48"].waitForExistence(timeout: 5))
        let eligible = recipient("Sophie")
        XCTAssertTrue(eligible.isEnabled)
        XCTAssertEqual(String(describing: named("Sophie").value ?? ""), "Not selected")
        XCTAssertTrue(app.staticTexts["4 of 8 selected"].exists)
        capture("bounded-normal31-unblocked-not-selected")
        let afterUnblock = record(eligible)
        centerTap(eligible, area: try reveal(eligible).0)
        XCTAssertTrue(app.staticTexts["5 of 8 selected"].exists)
        probes.append(["probe": "normal39-unblock", "allowed": 8, "blocked": 3,
                       "recipient_after_unblock": afterUnblock, "explicit_reselection_restored": record(eligible)])
        try checkpoint()

        try launch()
        try choose(18)
        let upload = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Your upload is complete")).firstMatch
        let unreadArea = try reveal(upload).0
        capture("bounded-normal18-upload-unread")
        let unread = record(upload)
        centerTap(upload, area: unreadArea)
        XCTAssertTrue(app.staticTexts["Preview · 24 of 48"].waitForExistence(timeout: 5))
        capture("bounded-normal18-opened24")
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Preview · 18 of 48"].waitForExistence(timeout: 5))
        _ = try reveal(upload)
        capture("bounded-normal18-upload-read")
        let read = record(upload)
        let issues = try audit(phase: "bounded-normal18-read")
        probes.append(["probe": "normal18-upload-open-and-back", "unread": unread, "read": read,
                       "destination": 24, "back_destination": 18, "native_read_audit_issues": issues])
        try checkpoint()
        try launch()
        try choose(10)
        capture("bounded-followups-normal-review-restored")
        try attachJSON(["reference_only": true, "functional_status": "passed", "probes": probes,
                        "final_screen": 10, "final_type": "normal", "language_override": false,
                        "spoken_voiceover_verified": false, "global_settings_changed": false,
                        "scope": "Bounded maximum31, normal39 and normal18 reference follow-ups; audit issues are retained and not waived"],
                       name: "bounded-followups-complete.json")
    }

    /// One real maximum-type filtered Masonry consumer, with physical viewport proof.
    /// No native audit replay, forced missing catalog, provider or send action.
    func test09MaximumFilteredSearchPhysicalReachability() throws {
        var geometry = [[String: Any]]()
        func record(_ element: XCUIElement) -> [String: Any] {
            let frame = element.frame
            return ["label": element.label, "identifier": element.identifier, "frame": rect(frame),
                    "value": String(describing: element.value ?? ""), "selected": element.isSelected,
                    "enabled": element.isEnabled,
                    "hittable": frame.intersects(app.frame) ? element.isHittable : false]
        }
        func surface() throws -> (element: XCUIElement, viewport: CGRect, evidence: [String: Any]) {
            XCTAssertTrue(referenceGestureReady(15))
            XCTAssertFalse(app.keyboards.firstMatch.exists, "Keyboard must not cover the physical test")
            let predicate = NSPredicate(format: "label BEGINSWITH %@", "Photo ")
            let scrolls = app.scrollViews.allElementsBoundByIndex.enumerated().map { ordinal, scroll in
                (ordinal: ordinal, element: scroll, photos: scroll.buttons.matching(predicate).count)
            }
            let candidates = scrolls.filter { !$0.element.identifier.hasPrefix("lovelies.horizontal.") && $0.photos > 0 }
            let inventory: [[String: Any]] = scrolls.map { row in
                ["ordinal": row.ordinal, "identifier": row.element.identifier,
                 "frame": rect(row.element.frame), "photo_descendants": row.photos]
            }
            XCTAssertEqual(candidates.count, 1, "A unique current nonhorizontal photo ancestor is required")
            let selected = try XCTUnwrap(candidates.first)
            let area = selected.element.frame.intersection(app.frame)
            XCTAssertTrue(finiteArea(area, minimum: 44))
            return (selected.element, area, ["scrolls": inventory, "selected_ordinal": selected.ordinal,
                    "app_frame": rect(app.frame), "scroll_frame": rect(selected.element.frame),
                    "viewport": rect(area), "keyboard_present": false,
                    "viewport_rule": "Actual unique vertical photo ancestor intersected with app frame; no inset or category waiver"])
        }
        func visible(_ element: XCUIElement, in area: CGRect) -> Bool {
            guard element.exists else { return false }
            let frame = element.frame
            return finiteArea(frame, minimum: 44) && frame.minY >= area.minY - 0.5 && frame.maxY <= area.maxY + 0.5
                && frame.minX >= area.minX - 0.5 && frame.maxX <= area.maxX + 0.5 && element.isEnabled && element.isHittable
        }
        func reveal(_ element: XCUIElement, phase: String) throws -> (CGRect, Int) {
            XCTAssertTrue(element.waitForExistence(timeout: 5))
            for step in 0...32 {
                let fresh = try surface()
                geometry.append(["phase": phase, "step": step, "surface": fresh.evidence, "target": record(element)])
                if step == 0 { try attachJSON(geometry, name: "filtered-search-\(phase)-initial-geometry.json") }
                if visible(element, in: fresh.viewport) {
                    try attachJSON(geometry, name: "filtered-search-\(phase)-revealed-geometry.json")
                    return (fresh.viewport, step)
                }
                if step == 32 {
                    try attachJSON(geometry, name: "filtered-search-failed-geometry.json")
                    capture("filtered-search-physical-reachability-failed")
                    XCTFail("Could not expose a fully visible44pt target after bounded slow touch drags")
                    break
                }
                let area = fresh.viewport
                let forward = element.frame.midY > area.midY
                let remaining = abs(element.frame.midY - area.midY)
                let length = max(CGFloat(12), min(CGFloat(55), min(area.height * 0.30, remaining)))
                let x = area.minX + area.width * 0.82
                let startY = area.minY + area.height * (forward ? 0.72 : 0.28)
                let endY = startY + (forward ? -length : length)
                let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
                origin.withOffset(CGVector(dx: x - app.frame.minX, dy: startY - app.frame.minY))
                    .press(forDuration: 0.05,
                           thenDragTo: origin.withOffset(CGVector(dx: x - app.frame.minX, dy: endY - app.frame.minY)),
                           withVelocity: XCUIGestureVelocity(rawValue: 40), thenHoldForDuration: 0.25)
            }
            throw NSError(domain: "LoveliesFilteredSearchReachability", code: 1)
        }
        func centerTap(_ element: XCUIElement, area: CGRect) {
            XCTAssertTrue(visible(element, in: area), "Offscreen activation cannot qualify physical reachability")
            let frame = element.frame, intersection = frame.intersection(area)
            XCTAssertGreaterThanOrEqual(frame.width, 44); XCTAssertGreaterThanOrEqual(frame.height, 44)
            XCTAssertGreaterThanOrEqual(intersection.width, 44); XCTAssertGreaterThanOrEqual(intersection.height, 44)
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        func selectedResults() -> [[String: Any]] {
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo ")).allElementsBoundByIndex.map(record)
        }
        try launch(large: true)
        try choose(15)
        let category = app.buttons.matching(identifier: "Favorites").firstMatch
        let (categoryArea, categoryDrags) = try reveal(category, phase: "category")
        capture("filtered-search-maximum-category-visible")
        centerTap(category, area: categoryArea)
        let photo = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo 2,")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 5))
        XCTAssertTrue(photo.label.contains("travel architecture city Italy"), "Actual filtered Masonry label is required")
        let before = selectedResults()
        XCTAssertEqual(before.count, 4)
        XCTAssertTrue(before.allSatisfy { ($0["selected"] as? Bool) == true && ($0["value"] as? String) == "Selected" })
        try attachJSON(["before": before, "surface": try surface().evidence], name: "filtered-search-filtered-initial.json")
        let (photoArea, photoDrags) = try reveal(photo, phase: "photo2")
        let reached = record(photo)
        capture("filtered-search-maximum-photo2-visible-before-tap")
        centerTap(photo, area: photoArea)
        XCTAssertTrue(app.staticTexts["Preview · 12 of 48"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.images["Photo 2"].exists)
        capture("filtered-search-maximum-viewer12")
        let back = app.buttons["Back"].firstMatch
        XCTAssertTrue(back.isHittable)
        XCTAssertGreaterThanOrEqual(back.frame.width, 44); XCTAssertGreaterThanOrEqual(back.frame.height, 44)
        back.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["Preview · 15 of 48"].waitForExistence(timeout: 5))
        let returned = selectedResults()
        XCTAssertEqual(returned.map { $0["label"] as? String }, before.map { $0["label"] as? String })
        XCTAssertEqual(returned.map { $0["value"] as? String }, before.map { $0["value"] as? String })
        XCTAssertTrue(returned.allSatisfy { ($0["selected"] as? Bool) == true })
        capture("filtered-search-maximum-returned15")
        let probe: [String: Any] = ["category_slow_drags": categoryDrags, "photo_slow_drags": photoDrags,
            "physical_viewport": rect(photoArea), "photo_before_tap": reached, "destination": 12,
            "back_destination": 15, "before_results": before, "returned_results": returned,
            "four_selected_preserved": true, "physical_center_tap": true]
        try launch()
        try choose(10)
        capture("filtered-search-normal-home-review-restored")
        try attachJSON(["reference_only": true, "functional_status": "passed",
                        "probe_kind": "maximum-filtered-search-physical-reachability", "probes": [probe],
                        "final_screen": 10, "final_type": "normal", "global_settings_changed": false,
                        "native_audit_replayed": false, "spoken_voiceover_verified": false,
                        "scope": "One actual maximum-type filtered Masonry reachability/physical tap/viewer/back case, no other matrix or absent-layout fixture"],
                       name: "filtered-search-physical-complete.json")
    }
}

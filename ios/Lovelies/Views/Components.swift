import SwiftUI
import UIKit

enum LoveliesTheme {
    static let canvas = Color(red: 9 / 255, green: 9 / 255, blue: 11 / 255)
    static let surface = Color(red: 27 / 255, green: 28 / 255, blue: 30 / 255)
    static let raised = Color(red: 37 / 255, green: 38 / 255, blue: 40 / 255)
    static let pink = Color(red: 1, green: 144 / 255, blue: 181 / 255)
    static let secondary = Color.white.opacity(0.68)
    static let stroke = Color.white.opacity(0.13)
}

/// Keeps the reference type proportions while following the user's text size.
private struct LoveliesScaledFont: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 17
    var weight: Font.Weight
    init(size: CGFloat, weight: Font.Weight) { _size = ScaledMetric(wrappedValue: size, relativeTo: .body); self.weight = weight }
    func body(content: Content) -> some View { content.font(.system(size: size, weight: weight)) }
}

extension View {
    func loveliesFont(size: CGFloat, weight: Font.Weight = .regular) -> some View { modifier(LoveliesScaledFont(size: size, weight: weight)) }
}

struct LoveliesPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Static task pages scroll when the keyboard, landscape or large text needs room.
struct LoveliesPage<Content: View>: View {
    var spacing: CGFloat = 18
    var padding: CGFloat = 22
    @ViewBuilder var content: Content
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: spacing) { content }
                    .padding(padding).frame(maxWidth: .infinity).frame(minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }
    }
}

struct AdaptiveActions<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var textSize
    @ViewBuilder var content: Content
    var body: some View {
        if textSize.isAccessibilitySize { VStack(spacing: 12) { content } }
        else { ViewThatFits(in: .horizontal) { HStack(spacing: 12) { content }; VStack(spacing: 12) { content } } }
    }
}

struct AssetImage: View {
    let name: String
    private var loadedImage: UIImage? {
        var paths = [name, "Resources/\(name)"]
        if (name as NSString).pathExtension.isEmpty {
            for ext in ["jpg", "png", "jpeg"] { paths += ["\(name).\(ext)", "Resources/\(name).\(ext)"] }
        }
        return paths.lazy.compactMap { UIImage(named: $0) }.first
    }
    var body: some View {
        if let value = loadedImage {
            Image(uiImage: value).resizable()
        } else {
            Rectangle().fill(LoveliesTheme.raised).overlay(Image(systemName: "photo").foregroundStyle(LoveliesTheme.secondary))
        }
    }
}

struct Wordmark: View {
    @EnvironmentObject private var store: DemoStore
    var width: CGFloat = 180
    var body: some View {
        AssetImage(name: "wordmark").scaledToFit().frame(width: width)
            .accessibilityLabel("Lovelies")
            .onLongPressGesture { store.showGallery = DemoStore.referenceReviewEnabled }
            .accessibilityAction(named: "Screen gallery") { if DemoStore.referenceReviewEnabled { store.showGallery = true } }
    }
}

struct GlowBackground: View {
    var strong = false
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                LoveliesTheme.canvas
                ForEach(0..<9) { index in
                    Circle().fill(LoveliesTheme.pink.opacity(index.isMultiple(of: 2) ? 0.19 : 0.1))
                        .frame(width: CGFloat(index.isMultiple(of: 3) ? 100 : 50))
                        .blur(radius: CGFloat(strong ? 12 : 24))
                        .position(x: geometry.size.width * [0.02, 0.35, 0.82, 0.08, 0.92, 0.2, 0.73, 0.03, 0.85][index], y: geometry.size.height * [0.24, 0.2, 0.12, 0.6, 0.82, 0.94, 0.64, 0.4, 0.48][index])
                }
            }
        }.ignoresSafeArea().accessibilityHidden(true)
    }
}

struct PageHeader: View {
    @EnvironmentObject private var store: DemoStore
    var title: String
    var subtitle: String? = nil
    var close = false
    var trailing = true
    var leadingTitle = false
    var back = true
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if back {
                Button { store.back() } label: { Image(systemName: close ? "xmark" : "chevron.left").font(.system(size: 21, weight: .regular)).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .accessibilityLabel(close ? String(localized: "Close") : String(localized: "Back"))
            }
            if leadingTitle {
                if !title.isEmpty { Text(title).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader) }
                Spacer(minLength: 0)
            } else {
                VStack(spacing: 4) {
                    if !title.isEmpty { Text(title).font(.headline).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader) }
                    if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true) }
                }.frame(maxWidth: .infinity)
            }
            if trailing { OverflowMenu() }
            else if !leadingTitle, back { Color.clear.frame(width: 44, height: 44) }
        }.foregroundStyle(.white).padding(.horizontal, 13).padding(.top, 3).padding(.bottom, 7)
    }
}

struct OverflowMenu: View {
    @EnvironmentObject private var store: DemoStore
    var body: some View {
        Menu {
            Button("Select photos to share", systemImage: "square.and.arrow.up") { store.go(.shareSelection) }
            Button("Add photos", systemImage: "plus") { store.go(.uploadEntry) }
            Button("Activity", systemImage: "clock") { store.go(.activity) }
            Button("Profile & settings", systemImage: "person.crop.circle") { store.go(.profile) }
            Button("Manage your face", systemImage: "face.smiling") { store.go(.faceManagement) }
            Button("Manage people", systemImage: "person.2") { store.go(.allowedPeople) }
            Button("Privacy & sharing", systemImage: "lock") { store.go(.privacy) }
            Button("Photo access", systemImage: "photo") { store.go(.photoAccessSettings) }
            Button("Notification settings", systemImage: "bell") { store.go(.notificationSettings) }
            Button("Storage", systemImage: "internaldrive") { store.go(.storage) }
            Button("Export your data", systemImage: "square.and.arrow.down") { store.go(.exportData) }
            Button("Account & security", systemImage: "shield") { store.go(.security) }
            Button("Help center", systemImage: "questionmark.circle") { store.go(.help) }
            Button("Shared history", systemImage: "clock.arrow.circlepath") { store.go(.sharedHistory) }
            Button("Report incorrect match", systemImage: "flag") { store.go(.incorrectMatch) }
            if DemoStore.referenceReviewEnabled {
                Divider()
                Button("Screen gallery · 48 screens", systemImage: "rectangle.grid.2x2") { store.showGallery = true }
            }
        } label: { Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44).background(.white.opacity(0.08), in: Circle()) }
        .accessibilityLabel("More options")
    }
}

struct PinkButton: View {
    var title: String
    var icon: String? = nil
    var enabled = true
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icon { Image(systemName: icon).font(.system(size: 20, weight: .medium)).accessibilityHidden(true) }
                Text(title).font(.body.weight(.semibold)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity).frame(minHeight: 49)
                .foregroundStyle(Color.black.opacity(0.93))
                .background(LoveliesTheme.pink.opacity(enabled ? 1 : 0.35), in: Capsule())
                .shadow(color: LoveliesTheme.pink.opacity(enabled ? 0.13 : 0), radius: 12)
        }.buttonStyle(LoveliesPressStyle()).disabled(!enabled)
    }
}

struct QuietButton: View {
    var title: String
    var enabled = true
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.body.weight(.medium)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).foregroundStyle(LoveliesTheme.secondary)
                .frame(maxWidth: .infinity).frame(minHeight: 47)
                .background(LoveliesTheme.surface, in: Capsule())
                .overlay(Capsule().stroke(LoveliesTheme.stroke, lineWidth: 1))
        }.buttonStyle(LoveliesPressStyle()).disabled(!enabled)
    }
}

struct Avatar: View {
    var asset: String
    var size: CGFloat = 50
    var pink = false
    var body: some View {
        AssetImage(name: asset).scaledToFill().frame(width: size, height: size).clipShape(Circle())
            .overlay(Circle().stroke(pink ? LoveliesTheme.pink : Color.white.opacity(0.6), lineWidth: pink ? 2 : 1))
            .shadow(color: pink ? LoveliesTheme.pink.opacity(0.35) : .clear, radius: 7)
            .accessibilityHidden(true)
    }
}

struct CheckBadge: View {
    var selected = true
    var heart = false
    var size: CGFloat = 29
    var body: some View {
        ZStack {
            Circle().fill(selected ? LoveliesTheme.pink : Color.black.opacity(0.15))
            if selected { Image(systemName: heart ? "heart.fill" : "checkmark").font(.system(size: size * 0.46, weight: .semibold)).foregroundStyle(.black) }
            else { Circle().stroke(Color.white.opacity(0.75), lineWidth: 1.4) }
        }.frame(width: size, height: size).shadow(color: selected ? LoveliesTheme.pink.opacity(0.25) : .clear, radius: 5)
        .accessibilityHidden(true)
    }
}

struct PhotoTile: View {
    var photo: DemoPhoto
    var height: CGFloat? = nil
    var selected: Bool? = nil
    var heart = false
    var people = false
    var badgeAction: (() -> Void)? = nil
    var action: () -> Void
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: action) {
                GeometryReader { geometry in
                    AssetImage(name: photo.asset).scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped()
                .overlay(alignment: .topTrailing) { if let selected, badgeAction == nil { CheckBadge(selected: selected, heart: heart).padding(6) } }
                .overlay(alignment: .bottomTrailing) {
                    if people { Image(systemName: "person.2.fill").font(.system(size: 15)).padding(6).background(.black.opacity(0.32), in: Circle()).padding(6) }
                }
                .clipShape(RoundedRectangle(cornerRadius: 11))
                }
            }.buttonStyle(LoveliesPressStyle()).accessibilityLabel("Photo \(photo.id), \(photo.tags)")
            .accessibilityAddTraits(selected == true ? .isSelected : [])
            .accessibilityValue(selected.map { $0 ? String(localized: "Selected") : String(localized: "Not selected") } ?? "")
            .accessibilityAction(named: selected == nil && badgeAction == nil ? String(localized: "Open photo") : heart ? (selected == true ? String(localized: "Remove from favorites") : String(localized: "Add to favorites")) : (selected == true ? String(localized: "Deselect photo") : String(localized: "Select photo"))) { if let badgeAction { badgeAction() } else { action() } }
            if let selected, let badgeAction {
                Button(action: badgeAction) { CheckBadge(selected: selected, heart: heart).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .buttonStyle(LoveliesPressStyle()).accessibilityLabel(heart ? (selected ? String(localized: "Remove from favorites") : String(localized: "Add to favorites")) : String(localized: "Change photo selection"))
                    .accessibilityHidden(true)
            }
        }.frame(height: height)
    }
}

struct MasonryPhotos: View {
    var photos = DemoPhoto.all
    var columns = 3
    var selected: Set<Int>? = nil
    var showOnlySelectedBadges = false
    var heart = false
    var people = false
    var heightScale: CGFloat = 1
    var badgeAction: ((DemoPhoto) -> Void)? = nil
    var action: (DemoPhoto) -> Void
    var body: some View {
        MasonryLayout(columns: columns) {
            ForEach(photos) { photo in
                PhotoTile(photo: photo, selected: badge(for: photo), heart: heart, people: people && photo.id.isMultiple(of: 3), badgeAction: badgeAction.map { callback in { callback(photo) } }) { action(photo) }
                    .layoutValue(key: PhotoRatioKey.self, value: photo.ratio * heightScale)
            }
        }
    }
    private func badge(for photo: DemoPhoto) -> Bool? {
        guard let selected else { return nil }
        let picked = selected.contains(photo.id)
        return showOnlySelectedBadges && !picked ? nil : picked
    }
}

private struct PhotoRatioKey: LayoutValueKey { static let defaultValue: CGFloat = 1 }

private struct MasonryLayout: Layout {
    var columns: Int
    var gap: CGFloat = 6
    var minimumTileSize: CGFloat = 0
    private func columnCount(for width: CGFloat) -> Int {
        guard minimumTileSize > 0 else { return max(1, columns) }
        return max(1, min(columns, Int((width + gap) / (minimumTileSize + gap))))
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 390
        let count = columnCount(for: width)
        let itemWidth = max(1, (width - CGFloat(count - 1) * gap) / CGFloat(count))
        var heights = Array(repeating: CGFloat.zero, count: count)
        for view in subviews {
            let column = heights.enumerated().min(by: { $0.element < $1.element })?.offset ?? 0
            heights[column] += max(minimumTileSize, itemWidth * view[PhotoRatioKey.self]) + gap
        }
        return CGSize(width: width, height: max(0, (heights.max() ?? 0) - gap))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let count = columnCount(for: bounds.width)
        let width = max(1, (bounds.width - CGFloat(count - 1) * gap) / CGFloat(count))
        var heights = Array(repeating: CGFloat.zero, count: count)
        for view in subviews {
            let column = heights.enumerated().min(by: { $0.element < $1.element })?.offset ?? 0
            let height = max(minimumTileSize, width * view[PhotoRatioKey.self])
            view.place(at: CGPoint(x: bounds.minX + CGFloat(column) * (width + gap), y: bounds.minY + heights[column]), proposal: ProposedViewSize(width: width, height: height))
            heights[column] += height + gap
        }
    }
}

struct BottomNavigation: View {
    @EnvironmentObject private var store: DemoStore
    var active: Screen
    var compact = false
    private var destinations: [(String, String, Screen)] {
        compact ? [("house", String(localized: "Home"), .home), ("magnifyingglass", String(localized: "Search"), .search), ("heart", String(localized: "Favorites"), .favorites), ("person", String(localized: "Profile"), .profile)] :
        [("house", String(localized: "Home"), .home), ("person.2", String(localized: "Matches"), .newMatches), ("photo", String(localized: "Photos"), .allPhotos), ("heart", String(localized: "Favorites"), .favorites), ("person", String(localized: "Profile"), .profile)]
    }
    var body: some View {
        HStack {
            ForEach(Array(destinations.enumerated()), id: \.offset) { _, item in
                Button { store.go(item.2) } label: {
                    Image(systemName: active == item.2 ? selectedIcon(item.0) : item.0)
                        .font(.system(size: 23, weight: .regular)).frame(maxWidth: .infinity).frame(height: 54)
                        .foregroundStyle(active == item.2 ? LoveliesTheme.pink : .white.opacity(0.82))
                        .shadow(color: active == item.2 ? LoveliesTheme.pink : .clear, radius: 12)
                }.accessibilityLabel(item.1).accessibilityAddTraits(active == item.2 ? .isSelected : [])
            }
        }.padding(.horizontal, 8).background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.13), lineWidth: 1))
            .padding(.horizontal, 12).padding(.bottom, 3)
    }
    private func selectedIcon(_ symbol: String) -> String {
        if ["house", "person", "heart"].contains(symbol) { return symbol + ".fill" }
        return symbol == "person.2" ? "person.2.fill" : symbol
    }
}

struct SegmentPills: View {
    var values: [String]
    @Binding var selected: String
    var body: some View {
        AdaptiveActions {
            ForEach(values, id: \.self) { value in
                Button { selected = value } label: {
                    Text(LocalizedStringKey(value)).loveliesFont(size: 14, weight: selected == value ? .semibold : .regular)
                        .foregroundStyle(selected == value ? .black : .white)
                        .frame(maxWidth: .infinity).frame(minHeight: 44).padding(.vertical, 8)
                        .background(selected == value ? LoveliesTheme.pink : LoveliesTheme.surface, in: Capsule())
                }.buttonStyle(LoveliesPressStyle()).accessibilityAddTraits(selected == value ? .isSelected : [])
            }
        }
    }
}

struct SettingsRow: View {
    @Environment(\.dynamicTypeSize) private var textSize
    var icon: String
    var title: String
    var subtitle: String? = nil
    var value: String? = nil
    var tint = Color.white
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 22)).frame(width: 29).foregroundStyle(tint).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).loveliesFont(size: 15).foregroundStyle(tint).fixedSize(horizontal: false, vertical: true)
                    if let subtitle { Text(subtitle).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary) }
                    if textSize.isAccessibilitySize, let value { Text(value).font(.body).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true) }
                }
                Spacer(minLength: 2)
                if !textSize.isAccessibilitySize, let value { Text(value).loveliesFont(size: 12).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.trailing) }
                Image(systemName: "chevron.right").font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary).accessibilityHidden(true)
            }.padding(.horizontal, 15).padding(.vertical, 15).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(LoveliesPressStyle()).accessibilityElement(children: .ignore).accessibilityLabel(title)
            .accessibilityValue([subtitle, value].compactMap { $0 }.joined(separator: ", "))
    }
}

struct GroupSurface<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { VStack(spacing: 0) { content }.background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(LoveliesTheme.stroke, lineWidth: 0.6)) }
}

struct RingHero: View {
    var symbol = "checkmark"
    var portrait: String? = nil
    var size: CGFloat = 170
    var progress: Double? = nil
    var body: some View {
        ZStack {
            ForEach(0..<20) { index in
                let angle = Double(index) * .pi * 2 / 20
                Image(systemName: index.isMultiple(of: 3) ? "sparkle" : "circle.fill")
                    .font(.system(size: index.isMultiple(of: 3) ? 9 : 4))
                    .foregroundStyle(LoveliesTheme.pink.opacity(index.isMultiple(of: 4) ? 0.45 : 0.9))
                    .offset(x: CGFloat(cos(angle)) * (size / 2 + 24), y: CGFloat(sin(angle)) * (size / 2 + 24))
            }
            Circle().stroke(LoveliesTheme.pink.opacity(0.15), lineWidth: 5)
            Circle().trim(from: 0, to: progress.map { CGFloat(max(0.1, $0)) } ?? 1)
                .stroke(LoveliesTheme.pink, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90)).shadow(color: LoveliesTheme.pink.opacity(0.7), radius: 13)
            if let portrait { Avatar(asset: portrait, size: size - 28) }
            else { Image(systemName: symbol).font(.system(size: size * 0.42, weight: .bold)).foregroundStyle(LoveliesTheme.pink).shadow(color: LoveliesTheme.pink.opacity(0.8), radius: 15) }
        }.frame(width: size, height: size).padding(26)
    }
}

struct PhotoHeart: View {
    var size: CGFloat = 160
    var body: some View { AssetImage(name: "photo-heart").scaledToFit().frame(width: size, height: size).shadow(color: LoveliesTheme.pink.opacity(0.18), radius: 20) }
}

struct FaceBrackets: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let length = rect.width * 0.17
        let curve: CGFloat = 14
        path.move(to: CGPoint(x: length, y: 0)); path.addLine(to: CGPoint(x: curve, y: 0)); path.addQuadCurve(to: CGPoint(x: 0, y: curve), control: .zero); path.addLine(to: CGPoint(x: 0, y: length))
        path.move(to: CGPoint(x: rect.maxX - length, y: 0)); path.addLine(to: CGPoint(x: rect.maxX - curve, y: 0)); path.addQuadCurve(to: CGPoint(x: rect.maxX, y: curve), control: CGPoint(x: rect.maxX, y: 0)); path.addLine(to: CGPoint(x: rect.maxX, y: length))
        path.move(to: CGPoint(x: 0, y: rect.maxY - length)); path.addLine(to: CGPoint(x: 0, y: rect.maxY - curve)); path.addQuadCurve(to: CGPoint(x: curve, y: rect.maxY), control: CGPoint(x: 0, y: rect.maxY)); path.addLine(to: CGPoint(x: length, y: rect.maxY))
        path.move(to: CGPoint(x: rect.maxX - length, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.maxX - curve, y: rect.maxY)); path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY - curve), control: CGPoint(x: rect.maxX, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - length))
        return path
    }
}

struct DemoSheet<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { VStack(alignment: .leading, spacing: 20) { content }.padding(22) }
                .background(LoveliesTheme.canvas)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }.preferredColorScheme(.dark).presentationDetents([.medium, .large])
    }
}

struct SourceReferenceTile: Decodable, Identifiable {
    let id: Int
    var asset: String
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
    let selected: Bool?
    let controlBaked: Bool?
    let controlBounds: [CGFloat]?
    let peopleBadge: Bool?
    let peopleBadgeBounds: [CGFloat]?
    let badgeX: CGFloat?
    let badgeY: CGFloat?
    let badgeSize: CGFloat?
    let badgeKind: String?
    let badgeOutlined: Bool?
}

struct SourceReferenceLayout: Decodable {
    let sourceBounds: [CGFloat]
    var tiles: [SourceReferenceTile]
    let cameraAsset: String?
    let cameraSourceBounds: [CGFloat]?
    let recentAssets: [String]?
    var aspectRatio: CGFloat {
        guard sourceBounds.count == 4 else { return 1 }
        return max(1, sourceBounds[2] - sourceBounds[0]) / max(1, sourceBounds[3] - sourceBounds[1])
    }
}

enum SourceReferenceCatalog {
    static let layouts: [String: SourceReferenceLayout] = {
        let url = Bundle.main.url(forResource: "reference-grids", withExtension: "json") ?? Bundle.main.url(forResource: "reference-grids", withExtension: "json", subdirectory: "Resources")
        guard let url, let data = try? Data(contentsOf: url), let layouts = try? JSONDecoder().decode([String: SourceReferenceLayout].self, from: data) else { return [:] }
        return layouts
    }()
    static func layout(_ route: Int) -> SourceReferenceLayout? {
        guard var result = layouts[String(route)], !result.tiles.isEmpty else { return nil }
        // Use bright copies for screen 30's native dimming and reversible selection.
        if route == 30, let bright = layouts["29"], Set(bright.tiles.map(\.id)) == Set(result.tiles.map(\.id)) {
            result.tiles = result.tiles.map { tile in
                var copy = tile
                if let source = bright.tiles.first(where: { $0.id == tile.id }) { copy.asset = source.asset }
                return copy
            }
        }
        return result
    }
    static func selectedIDs(_ route: Int) -> Set<Int>? {
        guard let layout = layout(route), layout.tiles.contains(where: { $0.selected != nil }) else { return nil }
        return Set(layout.tiles.filter { $0.selected == true }.map(\.id))
    }
    static func photo(_ id: Int, route: Int) -> DemoPhoto? {
        guard let layout = layout(route), let tile = layout.tiles.first(where: { $0.id == id }) else { return nil }
        return photo(tile, layout: layout)
    }
    static func photo(_ tile: SourceReferenceTile, layout: SourceReferenceLayout) -> DemoPhoto {
        let fixture = DemoPhoto.all.first(where: { $0.id == tile.id }) ?? DemoPhoto.all[0]
        let imageRatio = tile.height / max(0.001, tile.width) / layout.aspectRatio
        return DemoPhoto(id: tile.id, asset: (tile.asset as NSString).deletingPathExtension, tags: fixture.tags, ratio: imageRatio)
    }
    static func bakedControlBounds(_ tile: SourceReferenceTile, route: Int) -> [CGFloat]? {
        if route == 30, let bright = layouts["29"]?.tiles.first(where: { $0.id == tile.id && $0.asset == tile.asset }) { return bright.controlBounds }
        return tile.controlBounds
    }
    static func bakedPeopleBounds(_ tile: SourceReferenceTile, route: Int) -> [CGFloat]? {
        if route == 30, let bright = layouts["29"]?.tiles.first(where: { $0.id == tile.id && $0.asset == tile.asset }) { return bright.peopleBadgeBounds }
        return tile.peopleBadgeBounds
    }
    /// Screenshot fixtures contain UI markers. Reflow uses only an existing,
    /// unobscured rectangle of that same asset, then adds bounded native markers.
    static func reflowPresentation(_ photo: DemoPhoto) -> (crop: CGRect, ratio: CGFloat) {
        let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
        // These continuation fixtures contain exactly the same JPEG bytes as
        // their earlier tiles. Reuse their marker bounds, not their photo IDs.
        let markerAsset = ["ref21_16": "ref21_10", "ref21_17": "ref21_11", "ref21_18": "ref21_12"][photo.asset] ?? photo.asset
        for key in layouts.keys.sorted() {
            guard let layout = layouts[key],
                  let tile = layout.tiles.first(where: { ($0.asset as NSString).deletingPathExtension == markerAsset }) else { continue }
            let image = UIImage(named: tile.asset) ?? UIImage(named: "Resources/\(tile.asset)")
            let sourceWidth = max(1, image?.size.width ?? tile.width * (layout.sourceBounds[2] - layout.sourceBounds[0]))
            let sourceHeight = max(1, image?.size.height ?? tile.height * (layout.sourceBounds[3] - layout.sourceBounds[1]))
            let markers = [tile.controlBounds, tile.peopleBadgeBounds].compactMap { bounds -> CGRect? in
                guard let bounds, bounds.count == 4 else { return nil }
                let rect = CGRect(x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3])
                    .insetBy(dx: -2 / sourceWidth, dy: -2 / sourceHeight).intersection(unit)
                return rect.isNull || rect.isEmpty ? nil : rect
            }
            guard !markers.isEmpty else { return (unit, sourceHeight / sourceWidth) }
            let xs = Array(Set([CGFloat(0), 1] + markers.flatMap { [$0.minX, $0.maxX] })).sorted()
            let ys = Array(Set([CGFloat(0), 1] + markers.flatMap { [$0.minY, $0.maxY] })).sorted()
            var best = CGRect.zero
            for left in xs { for right in xs where right > left {
                for top in ys { for bottom in ys where bottom > top {
                    let candidate = CGRect(x: left, y: top, width: right - left, height: bottom - top)
                    guard !markers.contains(where: { $0.intersects(candidate) }) else { continue }
                    if candidate.width * candidate.height > best.width * best.height { best = candidate }
                } }
            } }
            let crop = best.isEmpty ? unit : best
            return (crop, sourceHeight / sourceWidth * crop.height / crop.width)
        }
        return (unit, photo.ratio) // A user-selected image has no reference UI baked into it.
    }
    static func recentAsset(_ index: Int, route: Int) -> String? {
        guard let assets = layouts[String(route)]?.recentAssets, assets.indices.contains(index) else { return nil }
        return assets[index]
    }
}

enum SourcePhotoBadge { case none, check, heart }

/// Reference crops retain their measured arrangement when every photo is tappable.
/// Compact fragments reflow into larger tiles without changing their photo actions.
struct SourcePhotoGrid: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let route: Int
    var filterIDs: Set<Int>? = nil
    var selection: Set<Int>? = nil
    var badge: SourcePhotoBadge = .none
    var showUnselectedBadges = false
    var dimUnselected = false
    var outlineSelection = false
    var photoOverrides: [Int: DemoPhoto]? = nil
    var requirePhotoOverrides = false
    var badgeAction: ((DemoPhoto) -> Void)? = nil
    var action: (DemoPhoto) -> Void

    private func visibleTiles(in layout: SourceReferenceLayout, unique: Bool = false) -> [SourceReferenceTile] {
        var seen: Set<Int> = []
        return layout.tiles.filter { tile in
            guard filterIDs?.contains(tile.id) ?? true,
                  !requirePhotoOverrides || photoOverrides?[tile.id] != nil else { return false }
            return !unique || seen.insert(tile.id).inserted
        }
    }

    private func minimumMeasuredWidth(in layout: SourceReferenceLayout) -> CGFloat {
        visibleTiles(in: layout).reduce(CGFloat.zero) { minimum, tile in
            max(minimum, max(44 / max(0.001, tile.width), 44 * layout.aspectRatio / max(0.001, tile.height)))
        }
    }

    var body: some View {
        if let layout = SourceReferenceCatalog.layout(route) {
            if textSize.isAccessibilitySize {
                reflowGrid(layout)
            } else {
                ViewThatFits(in: .horizontal) {
                    measuredGrid(layout).frame(minWidth: minimumMeasuredWidth(in: layout))
                    reflowGrid(layout)
                }
            }
        }
    }

    private func measuredGrid(_ layout: SourceReferenceLayout) -> some View {
        let tiles = visibleTiles(in: layout)
        return GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                ForEach(Array(tiles.enumerated()), id: \.offset) { index, tile in
                    let photo = photoOverrides?[tile.id] ?? SourceReferenceCatalog.photo(tile, layout: layout)
                    sourceTile(tile, photo: photo, reflow: false)
                        .frame(width: geometry.size.width * tile.width, height: geometry.size.height * tile.height)
                        .offset(x: geometry.size.width * tile.x, y: geometry.size.height * tile.y)
                        .accessibilityHidden(tiles.firstIndex(where: { $0.id == tile.id }) != index)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }.aspectRatio(layout.aspectRatio, contentMode: .fit)
    }

    private func reflowGrid(_ layout: SourceReferenceLayout) -> some View {
        MasonryLayout(columns: textSize.isAccessibilitySize ? 2 : 3, minimumTileSize: 96) {
            ForEach(visibleTiles(in: layout, unique: true)) { tile in
                let photo = photoOverrides?[tile.id] ?? SourceReferenceCatalog.photo(tile, layout: layout)
                let presentation = SourceReferenceCatalog.reflowPresentation(photo)
                sourceTile(tile, photo: photo, reflow: true)
                    // Partial screenshot fragments fit inside a useful photo target.
                    .layoutValue(key: PhotoRatioKey.self, value: min(2, max(0.55, presentation.ratio)))
            }
        }
    }

    private func sourceTile(_ tile: SourceReferenceTile, photo: DemoPhoto, reflow: Bool) -> some View {
        let chosen = selection?.contains(photo.id) ?? (tile.selected == true)
        return GeometryReader { geometry in
            let width = geometry.size.width
            let height = geometry.size.height
            let presentation = reflow ? SourceReferenceCatalog.reflowPresentation(photo) : (crop: CGRect(x: 0, y: 0, width: 1, height: 1), ratio: photo.ratio)
            let crop = presentation.crop
            let cropRatio = max(0.001, presentation.ratio)
            let imageWidth = reflow ? min(width, height / cropRatio) : width
            let imageHeight = reflow ? imageWidth * cropRatio : height
            let imageX = (width - imageWidth) / 2
            let imageY = (height - imageHeight) / 2
            let photoLabel = String(localized: "Photo \(photo.id)")
            let accessiblePhotoLabel = tile.peopleBadge == true ? photoLabel + ", " + String(localized: "People in this photo") : photoLabel
            ZStack(alignment: .topLeading) {
                Button { action(photo) } label: {
                    tileImage(photo, crop: crop, width: imageWidth, height: imageHeight, reflow: reflow)
                        .frame(width: width, height: height).background(Color.black)
                        .overlay { if dimUnselected && !chosen { Color.black.opacity(0.35) } }
                        .clipShape(RoundedRectangle(cornerRadius: 9)).contentShape(Rectangle())
                }.buttonStyle(LoveliesPressStyle()).accessibilityLabel(accessiblePhotoLabel)
                    .accessibilityAddTraits(chosen ? .isSelected : [])
                    .accessibilityValue(selection == nil ? "" : chosen ? String(localized: "Selected") : String(localized: "Not selected"))
                    .accessibilityAction(named: selection == nil && badgeAction == nil ? String(localized: "Open photo") : badge == .heart ? (chosen ? String(localized: "Remove from favorites") : String(localized: "Add to favorites")) : (chosen ? String(localized: "Deselect photo") : String(localized: "Select photo"))) { if let badgeAction { badgeAction(photo) } else { action(photo) } }
                if outlineSelection {
                    if tile.selected == true && !chosen {
                        RoundedRectangle(cornerRadius: min(imageWidth, imageHeight) * 0.28).stroke(Color.black, lineWidth: 6)
                            .frame(width: max(0, imageWidth - 3), height: max(0, imageHeight - 3)).position(x: width / 2, y: height / 2).allowsHitTesting(false)
                    }
                    if chosen {
                        RoundedRectangle(cornerRadius: min(imageWidth, imageHeight) * 0.28).stroke(LoveliesTheme.pink, lineWidth: 3)
                            .frame(width: max(0, imageWidth - 3), height: max(0, imageHeight - 3)).position(x: width / 2, y: height / 2).allowsHitTesting(false)
                    }
                }
                if !reflow, badge != .none, let bounds = SourceReferenceCatalog.bakedControlBounds(tile, route: route), bounds.count == 4 {
                    Ellipse().fill(Color.black).frame(width: imageWidth * bounds[2] + 1, height: imageHeight * bounds[3] + 1)
                        .position(x: imageX + imageWidth * (bounds[0] + bounds[2] / 2), y: imageY + imageHeight * (bounds[1] + bounds[3] / 2)).allowsHitTesting(false)
                }
                if badge != .none && (showUnselectedBadges || chosen || tile.selected == true) {
                    let sourceSize = tile.badgeSize.map { min(imageWidth, imageHeight) * $0 } ?? min(31, max(23, min(imageWidth, imageHeight) * 0.27))
                    let size = reflow ? min(31, max(23, sourceSize)) : sourceSize
                    let x = imageX + (reflow ? imageWidth - size / 2 - 5 : tile.badgeX.map { imageWidth * $0 } ?? (imageWidth - size / 2 - 5))
                    let y = imageY + (reflow ? size / 2 + 5 : tile.badgeY.map { imageHeight * $0 } ?? (size / 2 + 5))
                    let heart = badge == .heart || (tile.badgeKind.map { $0 == "heart" || $0 == "favorite" } ?? false)
                    if let badgeAction {
                        Button { badgeAction(photo) } label: {
                            SourceNativePhotoBadge(selected: chosen, heart: heart, outlined: tile.badgeOutlined == true, size: size)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }.buttonStyle(LoveliesPressStyle()).position(x: min(max(22, x), max(22, width - 22)), y: min(max(22, y), max(22, height - 22)))
                            .accessibilityLabel(heart ? (chosen ? String(localized: "Remove from favorites") : String(localized: "Add to favorites")) : (chosen ? String(localized: "Deselect photo") : String(localized: "Select photo")))
                            .accessibilityHidden(true)
                    } else {
                        SourceNativePhotoBadge(selected: chosen, heart: heart, outlined: tile.badgeOutlined == true, size: size).position(x: x, y: y).allowsHitTesting(false)
                    }
                }
                if !reflow, let baked = SourceReferenceCatalog.bakedPeopleBounds(tile, route: route), baked.count == 4 {
                    Ellipse().fill(Color.black).frame(width: imageWidth * baked[2] + 1, height: imageHeight * baked[3] + 1)
                        .position(x: imageX + imageWidth * (baked[0] + baked[2] / 2), y: imageY + imageHeight * (baked[1] + baked[3] / 2)).allowsHitTesting(false)
                }
                if tile.peopleBadge == true {
                    if !reflow, let bounds = tile.peopleBadgeBounds, bounds.count == 4 {
                        Image(systemName: "person.2.fill").accessibilityHidden(true).font(.system(size: min(imageWidth * bounds[2], imageHeight * bounds[3]) * 0.68)).foregroundStyle(.white)
                            .frame(width: imageWidth * bounds[2], height: imageHeight * bounds[3]).background(Color.black, in: Circle())
                            .position(x: imageX + imageWidth * (bounds[0] + bounds[2] / 2), y: imageY + imageHeight * (bounds[1] + bounds[3] / 2)).allowsHitTesting(false)
                    } else {
                        Image(systemName: "person.2.fill").accessibilityHidden(true).font(.system(size: 15)).foregroundStyle(.white)
                            .frame(width: 29, height: 29).background(Color.black, in: Circle())
                            .position(x: imageX + imageWidth - 20, y: imageY + imageHeight - 20).allowsHitTesting(false)
                    }
                }
            }.frame(width: width, height: height)
        }
    }

    @ViewBuilder private func tileImage(_ photo: DemoPhoto, crop: CGRect, width: CGFloat, height: CGFloat, reflow: Bool) -> some View {
        if reflow {
            ZStack(alignment: .topLeading) {
                AssetImage(name: photo.asset).scaledToFill()
                    .frame(width: width / crop.width, height: height / crop.height).clipped()
                    .offset(x: -crop.minX * width / crop.width, y: -crop.minY * height / crop.height)
            }.frame(width: width, height: height, alignment: .topLeading).clipped()
        } else {
            AssetImage(name: photo.asset).scaledToFill().frame(width: width, height: height).clipped()
        }
    }
}

private struct SourceNativePhotoBadge: View {
    var selected: Bool
    var heart: Bool
    var outlined = false
    var size: CGFloat
    var body: some View {
        ZStack {
            // Opaque backing covers a reference crop's baked selection marker.
            Circle().fill(Color.black)
            if selected {
                Circle().fill(LoveliesTheme.pink)
                Image(systemName: heart ? (outlined ? "heart" : "heart.fill") : "checkmark").font(.system(size: size * 0.47, weight: .semibold)).foregroundStyle(.black)
            } else {
                Circle().stroke(.white.opacity(0.85), lineWidth: 1.4)
                if heart { Image(systemName: "heart").font(.system(size: size * 0.47)).foregroundStyle(.white.opacity(0.85)) }
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

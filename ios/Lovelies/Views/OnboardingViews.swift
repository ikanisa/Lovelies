import SwiftUI

struct OnboardingViews: View {
    @EnvironmentObject private var store: DemoStore
    let screen: Screen
    @ViewBuilder var body: some View {
        switch screen {
        case .splash: splash
        case .introduction: introduction
        case .signIn: signIn
        case .photoAccessPrompt: accessPrompt
        case .photoAccessOptions: accessOptions
        case .faceEnrollment: enrollment
        case .faceQualityRetry: qualityRetry
        case .processing: processing
        default: setupComplete
        }
    }

    private var splash: some View {
        GeometryReader { geometry in
            ZStack {
                AssetImage(name: "splash").scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                    .overlay(Color.black.opacity(0.4)).ignoresSafeArea().accessibilityHidden(true)
                ScrollView {
                    VStack(spacing: 20) {
                        Spacer(minLength: 0)
                        Wordmark(width: geometry.size.width * 0.81)
                            .shadow(color: LoveliesTheme.pink.opacity(0.3), radius: 20)
                        Text("PHOTOS BRING\nPEOPLE CLOSER")
                            .loveliesFont(size: 14, weight: .medium).tracking(4).lineSpacing(6).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true).foregroundStyle(.white.opacity(0.9))
                        Spacer().frame(height: geometry.size.height * 0.07)
                        Button { store.go(.introduction) } label: {
                            Image(systemName: "arrow.right").font(.system(size: 32, weight: .light)).foregroundStyle(LoveliesTheme.canvas)
                                .frame(width: 88, height: 88).background(LoveliesTheme.pink, in: Circle())
                                .shadow(color: LoveliesTheme.pink.opacity(0.3), radius: 25)
                        }.accessibilityLabel("Get started")
                        Spacer().frame(height: geometry.size.height * 0.06)
                    }.padding(.horizontal, 22).frame(maxWidth: .infinity).frame(minHeight: geometry.size.height)
                }
            }
        }
    }

    private var introduction: some View {
        LoveliesPage(spacing: 17, padding: 16) {
            PageHeader(title: "", trailing: false)
            AssetImage(name: "intro-collage").scaledToFit().frame(maxHeight: 270).accessibilityHidden(true)
            Text("Your photos\nfind their people").font(.title2.weight(.semibold)).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
            AdaptiveActions {
                introItem(icon: "person.crop.circle.badge.checkmark", lines: String(localized: "We match\nyour photos"))
                introItem(icon: "person.2", lines: String(localized: "To the\nright people"))
                introItem(icon: "square.and.arrow.up", lines: String(localized: "You choose\nwhat to share"))
            }
            PinkButton(title: String(localized: "Get Started")) { store.go(.signIn) }
            HStack(spacing: 4) {
                ForEach(0..<3) { index in
                    Button { if index > 0 { store.go(.signIn) } } label: {
                        Circle().fill(index == 0 ? Color.white : .white.opacity(0.55)).frame(width: 8, height: 8).frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel(String.localizedStringWithFormat(NSLocalizedString("Introduction page %lld", comment: "Introduction page control"), index + 1)).accessibilityAddTraits(index == 0 ? .isSelected : [])
                }
            }
        }.foregroundStyle(.white)
    }

    private func introItem(icon: String, lines: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 28, weight: .light)).frame(width: 64, height: 64)
                .overlay(Circle().stroke(LoveliesTheme.pink, lineWidth: 1.4)).shadow(color: LoveliesTheme.pink.opacity(0.5), radius: 9)
                .accessibilityHidden(true)
            Text(lines).loveliesFont(size: 13, weight: .medium).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity)
    }

    private var signIn: some View {
        ZStack {
            GlowBackground()
            LoveliesPage {
                PageHeader(title: String(localized: "Welcome"), trailing: false)
                Wordmark(width: 210).padding(.vertical, 12)
                Text("Same photos.\nMore people in them.").font(.title3).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                PinkButton(title: String(localized: "Continue with Apple"), icon: "apple.logo") { store.go(.photoAccessPrompt) }
                QuietButton(title: String(localized: "Continue with Google")) { store.go(.photoAccessPrompt) }
                PinkButton(title: String(localized: "Create Account")) { store.go(.photoAccessPrompt) }
                QuietButton(title: String(localized: "Sign In")) { store.go(.photoAccessPrompt) }
                Text("Sample sign-in choices for this frontend preview.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
            }
        }.foregroundStyle(.white)
    }

    private var accessPrompt: some View {
        LoveliesPage {
            PageHeader(title: String(localized: "Photo Access"), trailing: false)
            PhotoHeart(size: 90).accessibilityHidden(true)
            Text("Choose your photos").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
            Text("Choose how this sample library is shown. In the connected app, you select images with Photos or Files; processing happens through the backend.")
                .font(.body).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
            permissionButton(String(localized: "Allow Full Access"), strong: true) { store.access = .all; store.go(.photoAccessOptions) }
            permissionButton(String(localized: "Allow Limited Access"), strong: false) { store.access = .limited; store.go(.photoAccessOptions) }
            QuietButton(title: String(localized: "Not Now")) { store.access = .limited; store.go(.photoAccessOptions) }
            Text("Preview choices do not change device permissions.").font(.footnote).foregroundStyle(LoveliesTheme.secondary)
        }.foregroundStyle(.white)
    }

    private func permissionButton(_ title: String, strong: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).loveliesFont(size: 15, weight: strong ? .semibold : .regular)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(strong ? LoveliesTheme.canvas : .white)
                .frame(maxWidth: .infinity).padding(.vertical, 12).frame(minHeight: 44)
                .background(LoveliesTheme.pink.opacity(strong ? 0.9 : 0.32), in: Capsule())
        }.buttonStyle(LoveliesPressStyle())
    }

    private var accessOptions: some View {
        LoveliesPage(spacing: 15, padding: 20) {
            PageHeader(title: String(localized: "Choose Photo Access"), trailing: false)
            ForEach(AccessMode.allCases, id: \.self) { mode in accessCard(mode) }
            PinkButton(title: String(localized: "Continue")) { store.captures = 0; store.go(.faceEnrollment) }
        }.foregroundStyle(.white)
    }

    private func accessCard(_ mode: AccessMode) -> some View {
        let selected = store.access == mode
        let icon = mode == .all ? "photo" : mode == .albums ? "rectangle.stack" : "lock.rectangle"
        let detail = mode == .all ? String(localized: "Get the best matches\nacross your entire library") : mode == .albums ? String(localized: "Choose specific albums") : String(localized: "Start with a few photos\n(you can change this anytime)")
        return Button { store.access = mode } label: {
            HStack(spacing: 16) {
                CheckBadge(selected: selected, size: 30)
                Image(systemName: icon).font(.system(size: 25, weight: .light)).frame(width: 31).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(LocalizedStringKey(mode.rawValue)).loveliesFont(size: 17, weight: .medium).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                    Text(detail).loveliesFont(size: 13).foregroundStyle(LoveliesTheme.secondary).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(17).frame(minHeight: 111).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(selected ? LoveliesTheme.pink : LoveliesTheme.stroke, lineWidth: selected ? 1.6 : 1))
                .shadow(color: selected ? LoveliesTheme.pink.opacity(0.13) : .clear, radius: 15)
        }.buttonStyle(LoveliesPressStyle()).accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var enrollment: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 15) {
                    AssetImage(name: "portrait").scaledToFill()
                        .frame(width: min(600, max(1, geometry.size.width - 22)), height: min(430, max(160, geometry.size.height * 0.6))).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 19)).accessibilityLabel("Sample selfie preview, simulated capture")
                    Button { store.capture() } label: {
                        Circle().fill(.white).frame(width: 52, height: 52).padding(5).overlay(Circle().stroke(.white, lineWidth: 2))
                    }.accessibilityLabel(String.localizedStringWithFormat(NSLocalizedString("Capture sample selfie %lld of 3", comment: "Reference capture control"), store.captures + 1))
                    Text(store.captures == 0 ? String(localized: "Position your face\nin the frame") : store.captures == 1 ? String(localized: "Turn slightly to your left\n2 of 3 sample selfies") : String(localized: "Turn slightly to your right\n3 of 3 sample selfies"))
                        .font(.body).multilineTextAlignment(.center).foregroundStyle(LoveliesTheme.secondary)
                }.padding(.bottom, 20).frame(maxWidth: .infinity)
            }.overlay(alignment: .topLeading) {
                Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 19)).frame(width: 48, height: 48).background(.black.opacity(0.6), in: Circle()) }.padding(16).accessibilityLabel("Back")
            }
        }
    }

    private var qualityRetry: some View {
        LoveliesPage {
            PageHeader(title: String(localized: "Try Again"), close: true, trailing: false)
            AssetImage(name: "retry-portrait").scaledToFit().frame(maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 24)).accessibilityHidden(true)
            Text("Let's try that again").font(.title2.weight(.medium)).accessibilityAddTraits(.isHeader)
            Text("Make sure your face is well lit, in focus, and centered.").font(.body).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
            PinkButton(title: String(localized: "Retake")) { store.go(.faceEnrollment) }
            QuietButton(title: String(localized: "Back to photo access")) { store.go(.photoAccessOptions) }
        }.foregroundStyle(.white)
    }

    private var processing: some View {
        LoveliesPage {
            PageHeader(title: String(localized: "Processing"), close: true, trailing: false)
            AssetImage(name: "processing-hero").scaledToFit().frame(maxHeight: 250).accessibilityHidden(true)
            Text("Finding sample photos…").font(.title2.weight(.medium)).accessibilityAddTraits(.isHeader)
            ProgressView(value: store.progress).tint(LoveliesTheme.pink).frame(minHeight: 44).accessibilityLabel("Sample processing progress")
            Text("This frontend preview uses included photos.").font(.body).foregroundStyle(LoveliesTheme.secondary)
            PinkButton(title: String(localized: "Continue preview")) { store.go(.setupComplete) }
            QuietButton(title: String(localized: "Back to setup")) { store.back() }
        }.foregroundStyle(.white)
    }

    private var setupComplete: some View {
        LoveliesPage {
            PageHeader(title: String(localized: "Setup Complete"), trailing: false)
            AssetImage(name: "setup-hero").scaledToFit().frame(maxHeight: 270).accessibilityHidden(true)
            Text("You're all set!").font(.title.weight(.medium)).accessibilityAddTraits(.isHeader)
            Text("Explore the sample photos and their people. You choose what to share.").font(.body).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
            PinkButton(title: String(localized: "Let's Go")) { store.history = []; store.go(.home, replace: true) }
        }.foregroundStyle(.white)
    }
}

private struct IntroCollage: View {
    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack {
                AssetImage(name: "photo01").scaledToFill().frame(width: width * 0.28, height: width * 0.36).clipped()
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.8), lineWidth: 2)).clipShape(RoundedRectangle(cornerRadius: 8))
                    .rotationEffect(.degrees(-13)).position(x: width * 0.27, y: geometry.size.height * 0.39)
                AssetImage(name: "photo17").scaledToFill().frame(width: width * 0.23, height: width * 0.23).clipped().clipShape(RoundedRectangle(cornerRadius: 9))
                    .rotationEffect(.degrees(4)).position(x: width * 0.57, y: geometry.size.height * 0.23)
                AssetImage(name: "photo04").scaledToFill().frame(width: width * 0.25, height: width * 0.26).clipped()
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.8), lineWidth: 2)).clipShape(RoundedRectangle(cornerRadius: 8))
                    .rotationEffect(.degrees(12)).position(x: width * 0.79, y: geometry.size.height * 0.27)
                AssetImage(name: "photo05").scaledToFill().frame(width: width * 0.24, height: width * 0.28).clipped().clipShape(RoundedRectangle(cornerRadius: 8))
                    .rotationEffect(.degrees(13)).position(x: width * 0.81, y: geometry.size.height * 0.77)
                PhotoHeart(size: width * 0.4).position(x: width * 0.5, y: geometry.size.height * 0.65)
                Avatar(asset: "person05", size: width * 0.16, pink: true).position(x: width * 0.08, y: geometry.size.height * 0.44)
                Avatar(asset: "person03", size: width * 0.16, pink: true).position(x: width * 0.91, y: geometry.size.height * 0.52)
                Avatar(asset: "person01", size: width * 0.17).position(x: width * 0.15, y: geometry.size.height * 0.86)
            }
        }
    }
}

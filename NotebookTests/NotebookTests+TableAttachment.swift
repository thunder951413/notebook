import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

    @MainActor
    func testTableAttachmentSelectionRenderingRespondsToSelectionAndAppearance() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "Selected")
        tableData.updateCell(row: 0, column: 1, value: "Other")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAppearance = try XCTUnwrap(NSAppearance(named: .darkAqua))

        let unselectedLight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: NSPoint(x: 24, y: 16))
        let selectedLight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        let selectedDark = try XCTUnwrap(renderedViewData(tableView, appearance: darkAppearance))

        XCTAssertNotEqual(unselectedLight, selectedLight)
        XCTAssertNotEqual(selectedLight, selectedDark)
    }

    @MainActor
    func testTableAttachmentEditingFieldUsesAdaptiveSystemBackground() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "Edit me")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        sendLeftDoubleClick(to: tableView, at: NSPoint(x: 24, y: 16))

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAppearance = try XCTUnwrap(NSAppearance(named: .darkAqua))
        let lightBackground = try XCTUnwrap(resolvedRGBA(editor.backgroundColor, appearance: lightAppearance))
        let darkBackground = try XCTUnwrap(resolvedRGBA(editor.backgroundColor, appearance: darkAppearance))

        XCTAssertNotEqual(lightBackground, darkBackground)
    }

    @MainActor
    func testTableAttachmentTabNavigationMatchesMouseSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 0, value: "A2")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        let initialSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        sendKeyDown(to: tableView, keyCode: 48, characters: "\t")
        let tabToNext = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertNotEqual(initialSelection, tabToNext)
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        let clickedNext = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(tabToNext, clickedNext)

        sendKeyDown(to: tableView, keyCode: 48, characters: "\t")
        let tabToNextRow = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 0, tableData: tableData))
        let clickedNextRow = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(tabToNextRow, clickedNextRow)

        sendKeyDown(to: tableView, keyCode: 48, characters: "\t", modifiers: .shift)
        let shiftTabBack = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        let clickedShiftTabBack = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(shiftTabBack, clickedShiftTabBack)
    }

    @MainActor
    func testTableAttachmentArrowNavigationWrapsAcrossEdges() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 0, value: "A2")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))

        sendKeyDown(to: tableView, keyCode: 123)
        let wrappedLeft = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        let clickedWrappedLeft = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(wrappedLeft, clickedWrappedLeft)

        sendKeyDown(to: tableView, keyCode: 126)
        let wrappedUp = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 1, tableData: tableData))
        let clickedWrappedUp = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(wrappedUp, clickedWrappedUp)

        sendKeyDown(to: tableView, keyCode: 124)
        let wrappedRight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 0, tableData: tableData))
        let clickedWrappedRight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(wrappedRight, clickedWrappedRight)
    }

    @MainActor
    func testTableAttachmentReturnKeyBeginsEditingSelectedCell() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        XCTAssertEqual(editor.stringValue, "A1")
    }

    @MainActor
    func testTableAttachmentEscapeCancelsEditingWithoutCommit() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Changed"

        sendKeyDown(to: tableView, keyCode: 53)

        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertTrue(editedValues.isEmpty)
    }

    @MainActor
    func testTableAttachmentEditingMoveDownCommitsAndSelectsNextRow() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Down"

        XCTAssertTrue(sendEditingCommand(#selector(NSResponder.moveDown(_:)), in: tableView))
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 1)
        XCTAssertEqual(editedValues.first?.2, "Edited Down")
        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 1, tableData: tableData))
        let clickedTarget = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(movedSelection, clickedTarget)
    }

    @MainActor
    func testTableAttachmentEditingMoveUpCommitsAndWrapsSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Up"

        XCTAssertTrue(sendEditingCommand(#selector(NSResponder.moveUp(_:)), in: tableView))
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 1)
        XCTAssertEqual(editedValues.first?.2, "Edited Up")
        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 1, tableData: tableData))
        let clickedTarget = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(movedSelection, clickedTarget)
    }

    @MainActor
    func testTableAttachmentPrintableKeyStartsEditingWithTypedCharacter() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 7, characters: "x")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        XCTAssertEqual(editor.stringValue, "x")
    }

    @MainActor
    func testTableAttachmentClickingOtherCellCommitsEditingAndMovesSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let sourcePoint = pointForTableCell(row: 0, col: 0, tableData: tableData)
        let targetPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)

        sendLeftDoubleClick(to: tableView, at: sourcePoint)
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Click"

        sendLeftClick(to: tableView, at: targetPoint)

        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 0)
        XCTAssertEqual(editedValues.first?.2, "Edited Click")

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: targetPoint)
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(movedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentClickingBlankAreaKeepsCurrentEditingSession() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let sourcePoint = pointForTableCell(row: 0, col: 0, tableData: tableData)
        let blankPoint = NSPoint(x: tableView.bounds.maxX + 20, y: tableView.bounds.maxY + 20)

        sendLeftDoubleClick(to: tableView, at: sourcePoint)
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Still Editing"

        sendLeftClick(to: tableView, at: blankPoint)

        let remainingEditor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        XCTAssertEqual(remainingEditor.stringValue, "Still Editing")
        XCTAssertTrue(editedValues.isEmpty)
    }

    @MainActor
    func testTableAttachmentRightClickOtherCellCommitsEditingAndUpdatesSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        var presentedMenuTitles: [String] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            },
            contextMenuPresenter: { menu, _, _ in
                presentedMenuTitles = menu.items.map(\.title)
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let sourcePoint = pointForTableCell(row: 0, col: 0, tableData: tableData)
        let targetPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)

        sendLeftDoubleClick(to: tableView, at: sourcePoint)
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Right Click"

        sendRightClick(to: tableView, at: targetPoint)

        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 0)
        XCTAssertEqual(editedValues.first?.2, "Edited Right Click")
        XCTAssertEqual(presentedMenuTitles, ["行操作", "列操作"])

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: targetPoint)
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(movedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentInsertRowAbovePreservesOriginalSelectionAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let targetPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)
        sendLeftClick(to: tableView, at: targetPoint)
        XCTAssertTrue(performTableAction("insertRowAbove:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.addRow(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 2, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentStructureActionCommitsActiveEditingBeforeMutatingTable() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        var editedValues: [(Int, Int, String)] = []
        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            },
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        sendLeftDoubleClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Committed Before Insert"

        XCTAssertTrue(performTableAction("insertColumnLeft:", on: tableView))
        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertEqual(structureChangeCount, 1)
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 0)
        XCTAssertEqual(editedValues.first?.2, "Committed Before Insert")
        XCTAssertEqual(tableView.intrinsicContentSize.width, 304)
    }

    @MainActor
    func testTableAttachmentDeleteRowSelectsNearestRemainingRowAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 3, columns: 2)
        tableData.updateCell(row: 2, column: 1, value: "C2")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let deletedRowPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)

        sendLeftClick(to: tableView, at: deletedRowPoint)
        XCTAssertTrue(performTableAction("deleteRow:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.removeRow(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 1, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentDeleteColumnSelectsNearestRemainingColumnAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 3)
        tableData.updateCell(row: 1, column: 2, value: "B3")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let deletedColumnPoint = pointForTableCell(row: 1, col: 2, tableData: tableData)

        sendLeftClick(to: tableView, at: deletedColumnPoint)
        XCTAssertTrue(performTableAction("deleteColumn:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.removeColumn(at: 2)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 1, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentInsertRowBelowKeepsCurrentSelectionAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 1, value: "A2")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let targetPoint = pointForTableCell(row: 0, col: 1, tableData: tableData)

        sendLeftClick(to: tableView, at: targetPoint)
        XCTAssertTrue(performTableAction("insertRowBelow:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.addRow(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 0, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentInsertColumnRightKeepsCurrentSelectionAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 1, column: 0, value: "B1")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let targetPoint = pointForTableCell(row: 1, col: 0, tableData: tableData)

        sendLeftClick(to: tableView, at: targetPoint)
        XCTAssertTrue(performTableAction("insertColumnRight:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.addColumn(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 1, col: 0, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentDeletingLastRemainingStructureDoesNothing() throws {
        let singleRowTableData = TableData(rows: 1, columns: 2)
        var rowStructureChangeCount = 0
        let (rowWindow, rowTableView) = makeHostedTableAttachmentView(
            tableData: singleRowTableData,
            onStructureChanged: {
                rowStructureChangeCount += 1
            }
        )
        defer { rowWindow.orderOut(nil) }

        let rowAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: rowTableView, at: pointForTableCell(row: 0, col: 1, tableData: singleRowTableData))
        XCTAssertTrue(performTableAction("deleteRow:", on: rowTableView))
        let afterRowDeletion = try XCTUnwrap(renderedViewData(rowTableView, appearance: rowAppearance))

        let (rowReferenceWindow, rowReferenceView) = makeHostedTableAttachmentView(tableData: singleRowTableData)
        defer { rowReferenceWindow.orderOut(nil) }
        sendLeftClick(to: rowReferenceView, at: pointForTableCell(row: 0, col: 1, tableData: singleRowTableData))
        let expectedRowSelection = try XCTUnwrap(renderedViewData(rowReferenceView, appearance: rowAppearance))

        XCTAssertEqual(afterRowDeletion, expectedRowSelection)
        XCTAssertEqual(rowStructureChangeCount, 0)

        let singleColumnTableData = TableData(rows: 2, columns: 1)
        var columnStructureChangeCount = 0
        let (columnWindow, columnTableView) = makeHostedTableAttachmentView(
            tableData: singleColumnTableData,
            onStructureChanged: {
                columnStructureChangeCount += 1
            }
        )
        defer { columnWindow.orderOut(nil) }

        sendLeftClick(to: columnTableView, at: pointForTableCell(row: 1, col: 0, tableData: singleColumnTableData))
        XCTAssertTrue(performTableAction("deleteColumn:", on: columnTableView))
        let afterColumnDeletion = try XCTUnwrap(renderedViewData(columnTableView, appearance: rowAppearance))

        let (columnReferenceWindow, columnReferenceView) = makeHostedTableAttachmentView(tableData: singleColumnTableData)
        defer { columnReferenceWindow.orderOut(nil) }
        sendLeftClick(to: columnReferenceView, at: pointForTableCell(row: 1, col: 0, tableData: singleColumnTableData))
        let expectedColumnSelection = try XCTUnwrap(renderedViewData(columnReferenceView, appearance: rowAppearance))

        XCTAssertEqual(afterColumnDeletion, expectedColumnSelection)
        XCTAssertEqual(columnStructureChangeCount, 0)
    }

    func testAttachmentThemeRenderingFilesUseSharedAppearanceTokens() throws {
        let expectedSnippets: [String: [String]] = [
            "Notebook/AudioBlockAttachment.swift": [
                "AttachmentAppearance.primaryTextColor",
                "AttachmentAppearance.secondaryTextColor",
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.secondaryBackgroundColor"
            ],
            "Notebook/TableTextAttachment.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableAttachmentView.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.selectionColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableInlineEditorView.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.selectionColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableAttachmentCell.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableEditorView.swift": [
                "AttachmentAppearance.secondaryBackgroundColor",
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/CheckboxTextAttachment.swift": [
                "AttachmentAppearance.uncheckedStrokeColor"
            ]
        ]
        let forbiddenPatterns = [
            #"isDark\s*\?\s*\.white\s*:\s*\.black"#,
            #"isDarkMode\s*\?\s*\.white\s*:\s*\.black"#,
            #"isDark\s*\?\s*NSColor\.white\s*:\s*NSColor\.black"#,
            #"isDarkMode\s*\?\s*NSColor\.white\s*:\s*NSColor\.black"#
        ]

        for (relativePath, snippets) in expectedSnippets {
            let source = try sourceFileContents(relativePath: relativePath)

            for snippet in snippets {
                XCTAssertTrue(source.contains(snippet), "\(relativePath) should contain \(snippet)")
            }

            for pattern in forbiddenPatterns {
                XCTAssertNil(
                    source.range(of: pattern, options: .regularExpression),
                    "\(relativePath) should not reintroduce hardcoded black/white theme branching"
                )
            }
        }
    }


    @MainActor
    func testRichTextViewActiveTableEditorRelayoutsAfterDeletingColumn() throws {
        let attachment = TableTextAttachment(rows: 2, columns: 3)
        attachment.tableData.updateCell(row: 0, column: 2, value: "C1")
        attachment.updateImage()

        let content = NSMutableAttributedString()
        let tableRange = NSRange(location: content.length, length: 1)
        content.append(NSAttributedString(attachment: attachment))

        let (window, textView) = makeHostedRichTextView(content: content)
        defer { window.orderOut(nil) }

        let clickPoint = try XCTUnwrap(pointForAttachment(in: textView, range: tableRange))
        sendLeftClick(to: textView, at: clickPoint)

        let editor = try XCTUnwrap(textView.subviews.compactMap { $0 as? TableInlineEditorView }.first)
        let originalWidth = editor.frame.width

        sendLeftClick(to: editor, at: pointForTableCell(row: 0, col: 2, tableData: attachment.tableData))
        XCTAssertNotNil(editor.perform(NSSelectorFromString("deleteCurrentColumn:"), with: nil))

        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        textView.layoutSubtreeIfNeeded()
        textView.displayIfNeeded()

        let activeEditors = textView.subviews.compactMap { $0 as? TableInlineEditorView }
        let updatedEditor = try XCTUnwrap(activeEditors.first)
        let expectedWidth = attachment.tableData.columnWidths.reduce(0, +) + CGFloat(attachment.tableData.columnCount + 1) * 0.5
        let expectedHeight = attachment.tableData.rowHeights.reduce(0, +) + CGFloat(attachment.tableData.rowCount + 1) * 0.5

        XCTAssertEqual(activeEditors.count, 1)
        XCTAssertEqual(attachment.tableData.columnCount, 2)
        XCTAssertLessThan(updatedEditor.frame.width, originalWidth)
        XCTAssertEqual(updatedEditor.frame.width, expectedWidth, accuracy: 0.5)
        XCTAssertEqual(updatedEditor.frame.height, expectedHeight, accuracy: 0.5)
    }
}
